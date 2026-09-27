import type { Candidate, CandidateSource } from './types.js';

interface ApiCandidate { market: `0x${string}`; tokenId: string | number; poolId: `0x${string}`; tier?: number }

export class IndexerSource implements CandidateSource {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = fetch) {}

  async candidates(): Promise<Candidate[]> {
    const response = await this.fetcher(`${this.baseUrl}/loans/keeper-candidates`);
    if (!response.ok) throw new Error(`keeper candidates request failed: ${response.status}`);
    const body = await response.json() as ApiCandidate[];
    if (!Array.isArray(body)) throw new Error('keeper candidates response must be an array');
    return body.map((row) => ({ market: row.market, tokenId: BigInt(row.tokenId), poolId: row.poolId, tier: row.tier ?? 2 }));
  }
}
