import { afterEach, describe, expect, it, vi } from 'vitest';
import { PonderIndexerSource } from '../src/indexer-source.js';
import { PrimaryKeeperService } from '../src/primary-service.js';
import type { AlertSink, PrimaryStore, Recorder } from '../src/types.js';

// Bodies as farmenta-defi/indexer serves them: Ponder's per-chain `/status`, and `toJson` rows
// (bigint columns as decimal strings) returned as plain arrays by src/api/app.ts.
const NOW = 1_800_000_000;
const MEME_POOL = '0x80399a859416860c92785ff7f994e67ecbcda12d3f0adb75e0c2466b9bfacf30';
const BLUE_CHIP_POOL = '0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32';
const UNINITIALIZED_POOL = '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6';
const MARKET = '0x00000000000000000000000000000000000000aa';

const status = (timestamp: number) => ({ robinhood: { id: 4663, block: { number: 74_018_510, timestamp } } });
const candidateRow = (tokenId: string, poolId: string) => ({
  market: MARKET, tokenId, owner: '0x00000000000000000000000000000000000000bb', poolId, status: 'in_custody', everBorrowed: true,
  borrowedUsdg: '529080000', repaidUsdg: '0', liquidatedUsdg: '0', depositedBlock: '74000000', depositedAt: '1799990000',
  lastActivityAt: '1799990000', closedAt: null, tickLower: -887220, tickUpper: 887220, liquidity: '1000', tier: 2,
});
const poolRow = (id: string, tier: number, key: boolean, observationAgeSeconds: string | null) => ({
  id, tier,
  currency0: key ? '0x0000000000000000000000000000000000000000' : null,
  currency1: key ? '0x5fc5360d0400a0fd4f2af552add042d716f1d168' : null,
  fee: key ? 460 : null, tickSpacing: key ? 9 : null, hooks: key ? '0x0000000000000000000000000000000000000000' : null,
  maxLtvBps: 3_000, ltBps: 2_500, liquidatorBonusBps: 1_000, removeHaircutBps: 0, debtCapUsdg: '20000000000', minPositionUsd: '0',
  frozen: false, rampLtFromBps: null, rampLtTargetBps: null, rampStart: null, rampDuration: null,
  listedBlock: '73000000', listedAt: '1799000000', updatedAt: '1799000000', lastObservationAt: '1799999700', observationAgeSeconds,
});

function indexer(routes: Record<string, unknown>) {
  const fetch = vi.fn(async (url: URL) => {
    if (!(url.pathname in routes)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[url.pathname]), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('PonderIndexerSource', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a fresh Ponder status and rejects a lagging or missing one', async () => {
    const source = new PonderIndexerSource('http://indexer.local', 60, () => NOW);
    indexer({ '/status': status(NOW - 60) });
    await expect(source.assertFresh()).resolves.toBeUndefined();
    indexer({ '/status': status(NOW - 61) });
    await expect(source.assertFresh()).rejects.toThrow('Indexer is too far behind');
    indexer({ '/status': {} });
    await expect(source.assertFresh()).rejects.toThrow('Indexer is too far behind');
  });

  it('reads keeper candidates from the plain array route', async () => {
    indexer({ '/loans/keeper-candidates': [candidateRow('1768881', MEME_POOL)] });
    await expect(new PonderIndexerSource('http://indexer.local', 60).candidates()).resolves.toEqual([
      { market: MARKET, tokenId: 1_768_881n, poolId: MEME_POOL },
    ]);
  });

  it('keeps only initialized meme pools from /pools and parses the decimal-string age', async () => {
    indexer({ '/pools': [poolRow(MEME_POOL, 2, true, '300'), poolRow(BLUE_CHIP_POOL, 1, true, '30'), poolRow(UNINITIALIZED_POOL, 2, false, null)] });
    await expect(new PonderIndexerSource('http://indexer.local', 60).pools()).resolves.toEqual([{
      id: MEME_POOL, currency0: '0x0000000000000000000000000000000000000000', currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
      fee: 460, tickSpacing: 9, hooks: '0x0000000000000000000000000000000000000000', observationAgeSeconds: 300,
    }]);
  });

  it('refuses a route that does not return an array', async () => {
    indexer({ '/loans/keeper-candidates': { data: [] } });
    await expect(new PonderIndexerSource('http://indexer.local', 60).candidates()).rejects.toThrow('did not return an array');
  });

  it('lets the primary service submit a batch from the real indexer responses', async () => {
    indexer({
      '/status': status(NOW - 5),
      '/loans/keeper-candidates': [candidateRow('1', MEME_POOL), candidateRow('2', UNINITIALIZED_POOL)],
      '/pools': [poolRow(MEME_POOL, 2, true, '300'), poolRow(BLUE_CHIP_POOL, 1, true, '30'), poolRow(UNINITIALIZED_POOL, 2, false, null)],
    });
    const recorder: Recorder = {
      debts: vi.fn().mockResolvedValue([10n, 10n]), observationCounts: vi.fn().mockResolvedValue([5]),
      submitBatch: vi.fn().mockResolvedValue('0xtx'), waitForReceipt: vi.fn().mockResolvedValue({ hash: '0xtx', gasUsed: 65_237n, gasPrice: 20_000_000n }),
    };
    const store: PrimaryStore = { saveRun: vi.fn(), dailyTotals: vi.fn().mockResolvedValue({ costUsd: 0, budgetUsd: 1 }), claimAlert: vi.fn().mockResolvedValue(true), releaseAlert: vi.fn(), heartbeat: vi.fn() };
    const alerts: AlertSink = { send: vi.fn() };
    const service = new PrimaryKeeperService(new PonderIndexerSource('http://indexer.local', 60, () => NOW), recorder, store, alerts, 2_400, () => NOW);

    await expect(service.run({ dryRun: false })).resolves.toMatchObject({ poolCount: 1, transactionHash: '0xtx' });
    expect(recorder.submitBatch).toHaveBeenCalledWith([expect.objectContaining({ id: MEME_POOL, fee: 460, tickSpacing: 9 })]);
  });
});
