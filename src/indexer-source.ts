import { IndexerError } from './errors.js';
import type { Address, Candidate, CandidateSource, IndexerSource, KeeperCandidate, PoolId, PoolKey } from './types.js';

const REQUEST_TIMEOUT_MS = 5_000;

// Shapes as the indexer serves them (farmenta-defi/indexer src/api/app.ts): `/status` is
// Ponder's own per-chain status, and the two routes return plain arrays of table rows.
interface PonderStatus { robinhood?: { block?: { timestamp?: number } } }
interface CandidateRow { market: string; tokenId: string; poolId: string }
interface PoolRow {
  id: string;
  currency0: string | null;
  currency1: string | null;
  fee: number | null;
  tickSpacing: number | null;
  hooks: string | null;
  tier: number;
  observationAgeSeconds: string | number | null;
}

export class PonderIndexerSource implements IndexerSource {
  constructor(
    private readonly baseUrl: string,
    private readonly maximumLagSeconds: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
  ) {}

  async assertFresh() {
    const status = await this.json<PonderStatus>('/status');
    const timestamp = Number(status.robinhood?.block?.timestamp);
    if (!Number.isFinite(timestamp) || this.now() - timestamp > this.maximumLagSeconds) {
      throw new Error('Indexer is too far behind for keeper selection');
    }
  }

  async candidates(): Promise<KeeperCandidate[]> {
    const rows = await this.json<CandidateRow[]>('/loans/keeper-candidates');
    return rows.map((row) => ({
      market: row.market as `0x${string}`,
      tokenId: BigInt(row.tokenId),
      poolId: row.poolId as `0x${string}`,
    }));
  }

  async pools(): Promise<PoolKey[]> {
    const rows = await this.json<PoolRow[]>('/pools');
    return rows.flatMap((row) => {
      // A null key means `Initialize` has not been indexed yet; such a pool cannot be recorded.
      if (row.tier !== 2 || row.currency0 === null || row.currency1 === null || row.fee === null || row.tickSpacing === null || row.hooks === null) return [];
      return [{
        id: row.id as `0x${string}`,
        currency0: row.currency0 as `0x${string}`,
        currency1: row.currency1 as `0x${string}`,
        fee: row.fee,
        tickSpacing: row.tickSpacing,
        hooks: row.hooks as `0x${string}`,
        observationAgeSeconds: row.observationAgeSeconds === null ? null : Number(row.observationAgeSeconds),
      }];
    });
  }

  private async json<T>(path: string): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Indexer request ${path} failed with ${response.status}`);
    const body = await response.json() as T;
    if (path !== '/status' && !Array.isArray(body)) throw new Error(`Indexer request ${path} did not return an array`);
    return body;
  }
}

interface ApiCandidate { market: Address; tokenId: string | number; poolId: PoolId; tier?: number; everBorrowed?: boolean }
function asRows(body: unknown): ApiCandidate[] {
  if (Array.isArray(body)) return body as ApiCandidate[];
  if (body && typeof body === 'object' && 'data' in body && Array.isArray(body.data)) return body.data as ApiCandidate[];
  throw new IndexerError('loan response must be an array or { data: array }');
}

export class LiquidationIndexerSource implements CandidateSource {
  constructor(private readonly baseUrl: string, private readonly markets: Address[], private readonly maxLagSeconds = 60, private readonly fetcher: typeof fetch = fetch, private readonly now = () => Math.floor(Date.now() / 1_000)) {}
  async candidates(): Promise<Candidate[]> {
    await this.assertFresh();
    const memeResponse = await this.fetcher(`${this.baseUrl}/loans/keeper-candidates`, { signal: AbortSignal.timeout(5_000) });
    if (!memeResponse.ok) throw new IndexerError(`keeper candidates request failed: ${memeResponse.status}`);
    const blueChipResponses = await Promise.all(this.markets.map(async (market) => {
      const response = await this.fetcher(`${this.baseUrl}/loans?status=in_custody&market=${market}`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new IndexerError(`market loan request failed: ${response.status}`); return asRows(await response.json());
    }));
    const poolsResponse = await this.fetcher(`${this.baseUrl}/pools`, { signal: AbortSignal.timeout(5_000) });
    if (!poolsResponse.ok) throw new IndexerError(`pool request failed: ${poolsResponse.status}`);
    const poolRows = asPoolRows(await poolsResponse.json());
    const pools = new Map(poolRows.filter((row) => row.currency0 && row.currency1 && row.hooks && row.fee !== undefined && row.tickSpacing !== undefined).map((row) => [row.id.toLowerCase(), {
      id: row.id as `0x${string}`, currency0: row.currency0 as Address, currency1: row.currency1 as Address, fee: row.fee!, tickSpacing: row.tickSpacing!, hooks: row.hooks as Address, observationAgeSeconds: row.observationAgeSeconds === undefined ? null : Number(row.observationAgeSeconds),
    }]));
    const rows = [...asRows(await memeResponse.json()), ...blueChipResponses.flat()].filter((row) => row.everBorrowed !== false);
    const candidates = new Map<string, Candidate>();
    for (const row of rows) { const candidate = { market: row.market, tokenId: BigInt(row.tokenId), poolId: row.poolId, tier: row.tier ?? 1, poolKey: pools.get(row.poolId.toLowerCase()) }; candidates.set(`${candidate.market.toLowerCase()}:${candidate.tokenId}`, candidate); }
    return [...candidates.values()];
  }
  private async assertFresh(): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/status`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new IndexerError(`indexer status request failed: ${response.status}`);
    const body = await response.json() as { lagSeconds?: number; block?: { timestamp?: number | string }; robinhood?: { block?: { timestamp?: number | string } } };
    const timestamp = body.lagSeconds === undefined ? Number(body.robinhood?.block?.timestamp ?? body.block?.timestamp) : this.now() - Number(body.lagSeconds);
    const lag = body.lagSeconds ?? (Number.isFinite(timestamp) ? this.now() - timestamp : Number.POSITIVE_INFINITY);
    if (!Number.isFinite(lag) || lag > this.maxLagSeconds) throw new IndexerError('indexer is stale; refusing to trust candidate enumeration');
  }
}

interface ApiPool { id: string; currency0?: string | null; currency1?: string | null; fee?: number | null; tickSpacing?: number | null; hooks?: string | null; observationAgeSeconds?: number | string | null }
function asPoolRows(body: unknown): ApiPool[] { if (Array.isArray(body)) return body as ApiPool[]; throw new IndexerError('pool response must be an array'); }
