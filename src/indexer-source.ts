import type { IndexerSource, KeeperCandidate, PoolKey } from './types.js';

type Json = Record<string, unknown>;

export class PonderIndexerSource implements IndexerSource {
  constructor(private readonly baseUrl: string, private readonly maximumLagSeconds: number) {}

  async assertFresh() {
    const status = await this.json('/status');
    const timestamp = Number(status.timestamp);
    if (!Number.isFinite(timestamp) || Math.floor(Date.now() / 1_000) - timestamp > this.maximumLagSeconds) {
      throw new Error('Indexer is too far behind for keeper selection');
    }
  }

  async candidates(): Promise<KeeperCandidate[]> {
    const response = await this.json('/loans/keeper-candidates');
    return (response.data as Json[]).map((candidate) => ({
      market: String(candidate.market) as `0x${string}`,
      tokenId: BigInt(String(candidate.tokenId)),
      poolId: String(candidate.poolId) as `0x${string}`,
    }));
  }

  async pools(): Promise<PoolKey[]> {
    const response = await this.json('/pools');
    return (response.data as Json[]).flatMap((pool) => {
      const key = pool.key as Json | null;
      if (!key || Number(pool.tier) !== 2) return [];
      return [{
        id: String(pool.id) as `0x${string}`,
        currency0: String(key.currency0) as `0x${string}`,
        currency1: String(key.currency1) as `0x${string}`,
        fee: Number(key.fee),
        tickSpacing: Number(key.tickSpacing),
        hooks: String(key.hooks) as `0x${string}`,
        observationAgeSeconds: pool.observationAgeSeconds === null ? null : Number(pool.observationAgeSeconds),
      }];
    });
  }

  private async json(path: string): Promise<Json> {
    const response = await fetch(new URL(path, this.baseUrl));
    if (!response.ok) throw new Error(`Indexer request ${path} failed with ${response.status}`);
    return await response.json() as Json;
  }
}
