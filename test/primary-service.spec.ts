import { describe, expect, it, vi } from 'vitest';
import { PrimaryKeeperService } from '../src/primary-service.js';
import type { AlertSink, IndexerSource, PoolKey, PrimaryStore, Recorder } from '../src/types.js';

const pool = (id: number, age: number | null = 300): PoolKey => ({
  id: `0x${id.toString(16).padStart(64, '0')}`, currency0: '0x0000000000000000000000000000000000000001', currency1: '0x0000000000000000000000000000000000000002',
  fee: 3_000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000', observationAgeSeconds: age,
});

function dependencies(pools: PoolKey[], counts: number[], totals = { costUsd: 0, budgetUsd: 100 }) {
  const indexer: IndexerSource = { assertFresh: vi.fn(), candidates: vi.fn().mockResolvedValue(pools.map((entry, index) => ({ market: '0x0000000000000000000000000000000000000003', tokenId: BigInt(index + 1), poolId: entry.id }))), pools: vi.fn().mockResolvedValue(pools) };
  const recorder: Recorder = { debts: vi.fn().mockResolvedValue(pools.map(() => 1n)), observationCounts: vi.fn().mockResolvedValue(counts), submitBatch: vi.fn().mockResolvedValue('0xtransaction'), waitForReceipt: vi.fn().mockResolvedValue({ hash: '0xtransaction', gasUsed: 100_000n, gasPrice: 20_000_000n }) };
  const store: PrimaryStore = { saveRun: vi.fn(), dailyTotals: vi.fn().mockResolvedValue(totals), claimAlert: vi.fn().mockResolvedValue(true), releaseAlert: vi.fn(), heartbeat: vi.fn() };
  const alerts: AlertSink = { send: vi.fn() };
  return { indexer, recorder, store, alerts };
}

describe('PrimaryKeeperService', () => {
  it('records active pools in one batch and excludes candidates with zero debt', async () => {
    const pools = [pool(1), pool(2)];
    const deps = dependencies(pools, [0]);
    vi.mocked(deps.recorder.debts).mockResolvedValue([1n, 0n]);
    await new PrimaryKeeperService(deps.indexer, deps.recorder, deps.store, deps.alerts, 2_400, () => 1_700_000_000).run({ dryRun: false });
    expect(deps.recorder.submitBatch).toHaveBeenCalledWith([pools[0]]);
    expect(deps.store.saveRun).toHaveBeenCalledWith(expect.objectContaining({ poolCount: 1, budgetUsd: 0.003131376 }));
  });

  it('uses a per-cycle gas budget that scales for filling, mixed, and steady batches', async () => {
    for (const counts of [[0], [0, 2_048], Array(10).fill(2_048)] as number[][]) {
      const pools = counts.map((_, index) => pool(index + 1));
      const deps = dependencies(pools, counts);
      await new PrimaryKeeperService(deps.indexer, deps.recorder, deps.store, deps.alerts, 2_400).run({ dryRun: false });
      const expectedGas = 21_000 + counts.filter((count) => count < 2_048).length * 44_237 + counts.filter((count) => count >= 2_048).length * 26_775;
      expect(vi.mocked(deps.store.saveRun).mock.calls[0][0].budgetUsd).toBeCloseTo(expectedGas * 20_000_000 / 1e18 * 2_400);
    }
  });

  it('alerts only when daily cost exceeds the summed scaled budget', async () => {
    const deps = dependencies([pool(1)], [0], { costUsd: 2, budgetUsd: 1 });
    await new PrimaryKeeperService(deps.indexer, deps.recorder, deps.store, deps.alerts, 2_400).run({ dryRun: false });
    expect(deps.alerts.send).toHaveBeenCalledWith(expect.stringContaining('exceeds'));
  });

  it('alerts before stale mode when a selected pool is older than 600 seconds', async () => {
    const deps = dependencies([pool(1, 601)], [0]);
    await new PrimaryKeeperService(deps.indexer, deps.recorder, deps.store, deps.alerts, 2_400).run({ dryRun: false });
    expect(deps.alerts.send).toHaveBeenCalledWith(expect.stringContaining('601s old'));
  });

  it('prints a dry run without broadcasting', async () => {
    const deps = dependencies([pool(1)], [0]);
    const result = await new PrimaryKeeperService(deps.indexer, deps.recorder, deps.store, deps.alerts, 2_400).run({ dryRun: true });
    expect(result).toEqual(expect.objectContaining({ dryRun: true, poolCount: 1 }));
    expect(deps.recorder.submitBatch).not.toHaveBeenCalled();
  });

  it('does not read candidates or submit a transaction when the indexer is stale', async () => {
    const deps = dependencies([pool(1)], [0]);
    vi.mocked(deps.indexer.assertFresh).mockRejectedValue(new Error('Indexer is too far behind'));
    await expect(new PrimaryKeeperService(deps.indexer, deps.recorder, deps.store, deps.alerts, 2_400).run({ dryRun: false })).rejects.toThrow('Indexer is too far behind');
    expect(deps.indexer.candidates).not.toHaveBeenCalled();
    expect(deps.recorder.submitBatch).not.toHaveBeenCalled();
  });
});
