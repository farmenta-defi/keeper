import type { IndexerSource, KeeperCandidate, PoolKey } from './types.js';

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
