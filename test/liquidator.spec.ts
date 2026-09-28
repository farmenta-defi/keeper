import { describe, expect, it, vi } from 'vitest';
import { Liquidator } from '../src/liquidator.js';
import type { AlertSink, Candidate, Chain, MarketAddresses, PositionState } from '../src/types.js';

const market: MarketAddresses = {
  market: '0x0000000000000000000000000000000000000001', lens: '0x0000000000000000000000000000000000000002',
  helper: '0x0000000000000000000000000000000000000003', policy: '0x0000000000000000000000000000000000000004',
};
const candidate: Candidate = { market: market.market, tokenId: 7n, poolId: `0x${'0'.repeat(64)}`, tier: 2 };
const unhealthy: PositionState = { healthFactor: 980_000_000_000_000_000n, debt: 1_000_000n, closeFactorBps: 10_000, rampStartsAt: 0, rampEndsAt: 0 };

function harness(state = unhealthy) {
  const chain: Chain = {
    positions: vi.fn(async () => new Map([[candidate.tokenId, state]])),
    quote: vi.fn(async () => ({ calldata: '0x1234' as const, expectedProfit: 1_000_000n })),
    simulate: vi.fn(async () => 100n), gasPrice: vi.fn(async () => 1n), submit: vi.fn(async () => '0xabc' as const), waitForReceipt: vi.fn(async () => undefined),
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
    expect(chain.waitForReceipt).toHaveBeenCalledWith('0xabc');
    expect(chain.submit).toHaveBeenCalledWith(market, candidate, 1_000_000n, expect.anything(), 100n, 1n);
    expect(chain.sweep).toHaveBeenCalledWith(market, expect.any(String));
  });

  it('does not submit an unprofitable transaction after gas', async () => {
    const { bot, chain } = harness();
    vi.mocked(chain.quote).mockResolvedValue({ calldata: '0x' as const, expectedProfit: 100n });
    await bot.cycle();
    expect(chain.submit).not.toHaveBeenCalled();
  });

  it('uses the fee-purchase-adjusted repayment returned by the route simulation', async () => {
    const { bot, chain } = harness();
    vi.mocked(chain.quote).mockResolvedValue({ calldata: '0x' as const, expectedProfit: 1_000_000n, requiredRepayAmount: 1_000_001n });
    await bot.cycle();
    expect(chain.simulate).toHaveBeenCalledWith(market, candidate, 1_000_001n, expect.anything());
    expect(chain.submit).toHaveBeenCalledWith(market, candidate, 1_000_001n, expect.anything(), 100n, 1n);
  });

  it('waits 60 seconds for an active LT ramp', async () => {
    const { chain, alerts } = harness({ ...unhealthy, rampStartsAt: 900, rampEndsAt: 2_000 });
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

  it('does not submit when a public liquidator clears a ramp candidate', async () => {
    const { chain, alerts } = harness({ ...unhealthy, rampStartsAt: 900, rampEndsAt: 2_000 });
    vi.mocked(chain.positions).mockResolvedValueOnce(new Map([[candidate.tokenId, { ...unhealthy, rampStartsAt: 900, rampEndsAt: 2_000 }]])).mockResolvedValueOnce(new Map([[candidate.tokenId, { ...unhealthy, debt: 0n, rampStartsAt: 900, rampEndsAt: 2_000 }]]));
    const bot = new Liquidator({ candidates: async () => [candidate] }, chain, alerts, { markets: [market], treasury: '0x0000000000000000000000000000000000000005', maxCallBatch: 100, minGasBalance: 1n, dryRun: false, now: () => 1_000 });
    await bot.cycle();
    await bot.cycle();
    expect(chain.simulate).not.toHaveBeenCalled();
    expect(chain.submit).not.toHaveBeenCalled();
  });

  it('alerts after an unhealthy position persists past 120 seconds', async () => {
    const { chain, alerts } = harness();
    let now = 1_000;
    vi.mocked(chain.quote).mockResolvedValue({ calldata: '0x' as const, expectedProfit: 0n });
    const persistentBot = new Liquidator({ candidates: async () => [candidate] }, chain, alerts, { markets: [market], treasury: '0x0000000000000000000000000000000000000005', maxCallBatch: 100, minGasBalance: 1n, dryRun: false, now: () => now });
    await persistentBot.cycle();
    now += 121;
    await persistentBot.cycle();
    expect(alerts.send).toHaveBeenCalledWith(expect.stringContaining('remains unhealthy'));
  });

  it('does not delay a position for a ramp that has not started', async () => {
    const { bot, chain } = harness({ ...unhealthy, rampStartsAt: 1_100, rampEndsAt: 2_000 });
    await bot.cycle();
    expect(chain.submit).toHaveBeenCalledOnce();
  });

  it('only fails cheaply when another liquidator wins the race', async () => {
    const { bot, chain } = harness();
    vi.mocked(chain.simulate).mockRejectedValue(new Error('PositionIsHealthy'));
    await bot.cycle();
    expect(chain.submit).not.toHaveBeenCalled();
  });

  it('deduplicates repeated failure alerts without disclosing provider errors', async () => {
    const { bot, chain, alerts } = harness();
    vi.mocked(chain.simulate).mockRejectedValue(new Error('https://paid-rpc.example failed'));
    await bot.cycle();
    await bot.cycle();
    await bot.cycle();
    expect(alerts.send).toHaveBeenCalledTimes(1);
    expect(alerts.send).toHaveBeenCalledWith(expect.not.stringContaining('paid-rpc'));
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
