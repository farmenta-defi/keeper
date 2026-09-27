import type { AlertSink, IndexerSource, KeeperCandidate, PoolKey, PrimaryStore, Recorder } from './types.js';

const OBSERVATION_ALERT_SECONDS = 600;
const OBSERVATION_CAPACITY = 2_048;
const BATCH_BASE_GAS = 21_000n;
const FILLING_POOL_GAS = 44_237n;
const STEADY_POOL_GAS = 26_775n;

export class PrimaryKeeperService {
  constructor(
    private readonly indexer: IndexerSource,
    private readonly recorder: Recorder,
    private readonly store: PrimaryStore,
    private readonly alerts: AlertSink,
    private readonly ethUsd: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
  ) {}

  async run({ dryRun }: { dryRun: boolean }) {
    await this.indexer.assertFresh();
    const [candidates, pools] = await Promise.all([this.indexer.candidates(), this.indexer.pools()]);
    const activePoolIds = await this.activePoolIds(candidates);
    const activePools = pools.filter((pool) => activePoolIds.has(pool.id));
    await this.alertStalePools(activePools);
    if (dryRun) return { dryRun: true, poolCount: activePools.length, pools: activePools };
    if (activePools.length === 0) {
      await this.store.heartbeat(this.now());
      return { dryRun: false, poolCount: 0 };
    }

    const observationCounts = await this.recorder.observationCounts(activePools.map((pool) => pool.id));
    await this.indexer.assertFresh();
    const ranAt = this.now();
    const transactionHash = await this.recorder.submitBatch(activePools);
    const receipt = await this.recorder.waitForReceipt(transactionHash);
    const budgetUsd = this.budgetUsd(observationCounts, receipt.gasPrice);
    const gasCostUsd = Number(receipt.gasUsed * receipt.gasPrice) / 1e18 * this.ethUsd;
    await this.store.saveRun({ ranAt, poolCount: activePools.length, gasUsed: receipt.gasUsed, gasCostUsd, budgetUsd, transactionHash: receipt.hash });
    const totals = await this.store.dailyTotals();
    const alertKey = `keeper-budget-${new Date(ranAt * 1_000).toISOString().slice(0, 10)}`;
    if (totals.costUsd > totals.budgetUsd && await this.store.claimAlert(alertKey, ranAt, 86_400)) {
      const filling = observationCounts.filter((count) => count < OBSERVATION_CAPACITY).length;
      await this.sendAlert(alertKey, `Keeper daily gas cost $${totals.costUsd.toFixed(2)} exceeds its $${totals.budgetUsd.toFixed(2)} ${this.phase(filling, activePools.length)} budget.`);
    }
    await this.store.heartbeat(ranAt);
    return { dryRun: false, poolCount: activePools.length, transactionHash: receipt.hash };
  }

  private budgetUsd(counts: number[], gasPrice: bigint) {
    const filling = BigInt(counts.filter((count) => count < OBSERVATION_CAPACITY).length);
    const steady = BigInt(counts.length) - filling;
    return Number(BATCH_BASE_GAS + FILLING_POOL_GAS * filling + STEADY_POOL_GAS * steady) * Number(gasPrice) / 1e18 * this.ethUsd;
  }

  private phase(filling: number, total: number) {
    return filling === 0 ? 'steady-state' : filling === total ? 'filling' : 'mixed';
  }

  private async activePoolIds(candidates: KeeperCandidate[]) {
    const byMarket = new Map<string, KeeperCandidate[]>();
    for (const candidate of candidates) byMarket.set(candidate.market, [...(byMarket.get(candidate.market) ?? []), candidate]);
    const active = new Set<string>();
    for (const [market, marketCandidates] of byMarket) {
      const debts = await this.recorder.debts(market as `0x${string}`, marketCandidates.map(({ tokenId }) => tokenId));
      marketCandidates.forEach((candidate, index) => { if (debts[index] > 0n) active.add(candidate.poolId); });
    }
    return active;
  }

  private async alertStalePools(pools: PoolKey[]) {
    await Promise.all(pools.filter((pool) => pool.observationAgeSeconds !== null && pool.observationAgeSeconds > OBSERVATION_ALERT_SECONDS).map(async (pool) => {
      const key = `keeper-stale-${pool.id}`;
      if (await this.store.claimAlert(key, this.now(), 3_600)) {
        await this.sendAlert(key, `TWAP observation for ${pool.id} is ${pool.observationAgeSeconds}s old; stale at 900s.`);
      }
    }));
  }

  private async sendAlert(key: string, message: string) {
    try { await this.alerts.send(message); } catch (error) {
      console.error('Keeper alert delivery failed', error);
      await this.store.releaseAlert(key);
    }
  }
}
