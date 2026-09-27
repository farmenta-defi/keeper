import type { Address, Candidate, CandidateSource } from './types.js';

interface ApiCandidate { market: `0x${string}`; tokenId: string | number; poolId: `0x${string}`; tier?: number; everBorrowed?: boolean }

function asRows(body: unknown): ApiCandidate[] {
  if (Array.isArray(body)) return body as ApiCandidate[];
  if (body && typeof body === 'object' && 'data' in body && Array.isArray(body.data)) return body.data as ApiCandidate[];
  throw new Error('loan response must be an array or { data: array }');
}

export class IndexerSource implements CandidateSource {
  constructor(private readonly baseUrl: string, private readonly markets: Address[], private readonly fetcher: typeof fetch = fetch) {}

  async candidates(): Promise<Candidate[]> {
    const memeResponse = await this.fetcher(`${this.baseUrl}/loans/keeper-candidates`);
    if (!memeResponse.ok) throw new Error(`keeper candidates request failed: ${memeResponse.status}`);
    const blueChipResponses = await Promise.all(this.markets.map(async (market) => {
      const response = await this.fetcher(`${this.baseUrl}/loans?status=in_custody&market=${market}`);
      if (!response.ok) throw new Error(`market loan request failed: ${response.status}`);
      return asRows(await response.json());
    }));
    const rows = [...asRows(await memeResponse.json()), ...blueChipResponses.flat()]
      .filter((row) => row.everBorrowed !== false);
    const candidates = new Map<string, Candidate>();
    for (const row of rows) {
      const candidate = { market: row.market, tokenId: BigInt(row.tokenId), poolId: row.poolId, tier: row.tier ?? 1 };
      candidates.set(`${candidate.market.toLowerCase()}:${candidate.tokenId}`, candidate);
    }
    return [...candidates.values()];
  }
}
