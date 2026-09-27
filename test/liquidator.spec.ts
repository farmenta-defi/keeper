import { describe, expect, it, vi } from 'vitest';
import { Liquidator } from '../src/liquidator.js';
import type { AlertSink, Candidate, Chain, MarketAddresses, PositionState } from '../src/types.js';

const market: MarketAddresses = {
  market: '0x0000000000000000000000000000000000000001', lens: '0x0000000000000000000000000000000000000002',
  helper: '0x0000000000000000000000000000000000000003', policy: '0x0000000000000000000000000000000000000004',
};
const candidate: Candidate = { market: market.market, tokenId: 7n, poolId: `0x${'0'.repeat(64)}`, tier: 2 };
const unhealthy: PositionState = { healthFactor: 980_000_000_000_000_000n, debt: 1_000_000n, closeFactorBps: 10_000, rampEndsAt: 0 };

function harness(state = unhealthy) {
  const chain: Chain = {
    positions: vi.fn(async () => new Map([[candidate.tokenId, state]])),
    quote: vi.fn(async () => ({ calldata: '0x1234' as const, expectedProfit: 1_000_000n })),
    simulate: vi.fn(async () => 100n), gasPrice: vi.fn(async () => 1n), submit: vi.fn(async () => '0xabc' as const),
    sweep: vi.fn(async () => '0xsweep' as const), gasBalance: vi.fn(async () => 10_000n),
  };
  const alerts: AlertSink = { send: vi.fn(async () => undefined) };
  const bot = new Liquidator({ candidates: async () => [candidate] }, chain, alerts, {
    markets: [market], treasury: '0x0000000000000000000000000000000000000005', maxCallBatch: 100,
    minGasBalance: 1n, dryRun: false, now: () => 1_000, log: vi.fn(),
  });
  return { bot, chain, alerts };
}

describe('Liquidator', () => {
  it('submits an unhealthy non-ramp position in the next poll', async () => {
    const { bot, chain } = harness();
    await bot.cycle();
    expect(chain.simulate).toHaveBeenCalledWith(market, candidate, 1_000_000n, expect.anything());
    expect(chain.submit).toHaveBeenCalledOnce();
    expect(chain.sweep).toHaveBeenCalledWith(market, expect.any(String));
  });

  it('does not submit an unprofitable transaction after gas', async () => {
    const { bot, chain } = harness();
    vi.mocked(chain.quote).mockResolvedValue({ calldata: '0x' as const, expectedProfit: 100n });
    await bot.cycle();
    expect(chain.submit).not.toHaveBeenCalled();
  });

  it('waits 60 seconds for an active LT ramp', async () => {
    const { chain, alerts } = harness({ ...unhealthy, rampEndsAt: 2_000 });
    let now = 1_000;
    const bot = new Liquidator({ candidates: async () => [candidate] }, chain, alerts, {
      markets: [market], treasury: '0x0000000000000000000000000000000000000005', maxCallBatch: 100,
      minGasBalance: 1n, dryRun: false, now: () => now,
    });
    await bot.cycle();
    expect(chain.submit).not.toHaveBeenCalled();
    now += 60;
    await bot.cycle();
    expect(chain.submit).toHaveBeenCalledOnce();
  });

  it('only fails cheaply when another liquidator wins the race', async () => {
    const { bot, chain } = harness();
    vi.mocked(chain.simulate).mockRejectedValue(new Error('PositionIsHealthy'));
    await bot.cycle();
    expect(chain.submit).not.toHaveBeenCalled();
  });

  it('prints a transaction plan in dry-run mode without sending', async () => {
    const { chain, alerts } = harness();
    const log = vi.fn();
    const bot = new Liquidator({ candidates: async () => [candidate] }, chain, alerts, {
      markets: [market], treasury: '0x0000000000000000000000000000000000000005', maxCallBatch: 100,
      minGasBalance: 1n, dryRun: true, now: () => 1_000, log,
    });
    await bot.cycle();
    expect(log).toHaveBeenCalledOnce();
    expect(chain.submit).not.toHaveBeenCalled();
  });
});
