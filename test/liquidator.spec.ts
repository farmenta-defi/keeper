import { describe, expect, it, vi } from 'vitest';
import { encodeErrorResult, parseAbi } from 'viem';
import { helperAbi, liquidationErrorsAbi } from '../src/contract-abi.js';
import { IndexerError, RouteUnavailableError } from '../src/errors.js';
import { Liquidator } from '../src/liquidator.js';
import { SimulationRevertedError } from '../src/revert.js';
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
    sweep: vi.fn(async () => '0xsweep' as const), gasBalance: vi.fn(async () => 10_000n), recordPool: vi.fn(async () => '0xrecord' as const),
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
    expect(chain.simulate).toHaveBeenCalledWith(market, candidate, 1_010_000n, expect.anything());
    expect(chain.submit).toHaveBeenCalledOnce();
    expect(chain.waitForReceipt).toHaveBeenCalledWith('0xabc');
    expect(chain.submit).toHaveBeenCalledWith(market, candidate, 1_010_000n, expect.anything(), 120n, 1n);
    expect(chain.sweep).toHaveBeenCalledWith(market, expect.any(String));
  });

  it('does not submit an unprofitable transaction after gas', async () => {
    const { bot, chain } = harness();
    vi.mocked(chain.quote).mockResolvedValue({ calldata: '0x' as const, expectedProfit: 0n });
    await bot.cycle();
    expect(chain.submit).not.toHaveBeenCalled();
  });

  it('uses the fee-purchase-adjusted repayment returned by the route simulation', async () => {
    const { bot, chain } = harness();
    vi.mocked(chain.quote).mockResolvedValue({ calldata: '0x' as const, expectedProfit: 1_000_000n, requiredRepayAmount: 1_000_001n });
    await bot.cycle();
    expect(chain.simulate).toHaveBeenCalledWith(market, candidate, 1_010_000n, expect.anything());
    expect(chain.submit).toHaveBeenCalledWith(market, candidate, 1_010_000n, expect.anything(), 120n, 1n);
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

  it('does not broadcast when the quoted minOut would revert', async () => {
    const { bot, chain } = harness();
    vi.mocked(chain.simulate).mockRejectedValue(new Error('V4TooLittleReceived'));
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

  it('continues monitoring when gas is below the send threshold', async () => {
    const { bot, chain } = harness();
    vi.mocked(chain.gasBalance).mockResolvedValue(0n);
    await bot.cycle();
    expect(chain.positions).toHaveBeenCalled();
    expect(chain.submit).toHaveBeenCalledOnce();
  });

  it('alerts and survives an indexer failure', async () => {
    const { chain, alerts } = harness();
    const source = { candidates: vi.fn().mockRejectedValue(new Error('indexer is stale')) };
    const bot = new Liquidator(source, chain, alerts, { markets: [market], treasury: market.market, maxCallBatch: 100, minGasBalance: 1n, dryRun: false });
    await bot.cycle();
    expect(alerts.send).toHaveBeenCalledWith(expect.stringContaining('cycle failed'));
  });

  it('records a stale pool and waits 60 seconds before liquidation', async () => {
    const poolKey = { id: candidate.poolId, currency0: market.market, currency1: market.lens, fee: 500, tickSpacing: 10, hooks: market.helper, observationAgeSeconds: null };
    const { chain, alerts } = harness({ ...unhealthy, stale: true });
    const staleCandidate = { ...candidate, poolKey };
    const source = { candidates: async () => [staleCandidate] };
    let now = 1_000;
    const bot = new Liquidator(source, chain, alerts, { markets: [market], treasury: market.market, maxCallBatch: 100, minGasBalance: 1n, dryRun: false, now: () => now });
    await bot.cycle();
    expect(chain.recordPool).toHaveBeenCalledWith(poolKey);
    expect(chain.submit).not.toHaveBeenCalled();
    now += 60;
    await bot.cycle();
    expect(chain.submit).toHaveBeenCalledOnce();
  });

  it('waits out the 60 seconds of a stale spell even after its own record made the pool fresh', async () => {
    const poolKey = { id: candidate.poolId, currency0: market.market, currency1: market.lens, fee: 500, tickSpacing: 10, hooks: market.helper, observationAgeSeconds: null };
    const { chain, alerts } = harness();
    vi.mocked(chain.positions).mockResolvedValueOnce(new Map([[candidate.tokenId, { ...unhealthy, stale: true }]])).mockResolvedValue(new Map([[candidate.tokenId, { ...unhealthy, stale: false }]]));
    let now = 1_000;
    const bot = new Liquidator({ candidates: async () => [{ ...candidate, poolKey }] }, chain, alerts, { markets: [market], treasury: market.market, maxCallBatch: 100, minGasBalance: 1n, dryRun: false, now: () => now });
    await bot.cycle();
    now += 2;
    await bot.cycle();
    expect(chain.submit).not.toHaveBeenCalled();
    now += 58;
    await bot.cycle();
    expect(chain.submit).toHaveBeenCalledOnce();
    expect(chain.recordPool).toHaveBeenCalledOnce();
  });

  it('records a pool once per stale spell, whatever the other loans of the pool read', async () => {
    const poolKey = { id: candidate.poolId, currency0: market.market, currency1: market.lens, fee: 500, tickSpacing: 10, hooks: market.helper, observationAgeSeconds: null };
    const healthyLoan = { ...candidate, tokenId: 6n, poolKey };
    const unhealthyLoan = { ...candidate, poolKey };
    const { chain, alerts } = harness();
    const stale = (spell: boolean) => new Map([[6n, { ...unhealthy, healthFactor: 2n * 10n ** 18n, stale: spell }], [7n, { ...unhealthy, stale: spell }]]);
    // Under 30 minutes of history: `consult` keeps reverting after the record.
    vi.mocked(chain.positions).mockResolvedValue(stale(true));
    vi.mocked(chain.quote).mockResolvedValue({ calldata: '0x' as const, expectedProfit: 0n });
    let now = 1_000;
    const bot = new Liquidator({ candidates: async () => [healthyLoan, unhealthyLoan] }, chain, alerts, { markets: [market], treasury: market.market, maxCallBatch: 100, minGasBalance: 1n, dryRun: false, now: () => now });
    for (let cycle = 0; cycle < 30; cycle += 1) { await bot.cycle(); now += 2; }
    expect(chain.recordPool).toHaveBeenCalledOnce();

    vi.mocked(chain.positions).mockResolvedValueOnce(stale(false)).mockResolvedValue(stale(true));
    await bot.cycle();
    now += 86_400;
    await bot.cycle();
    expect(chain.recordPool).toHaveBeenCalledTimes(2);
  });

  it('compares the profit with the gas in USDG', async () => {
    // 600,000 gas at 0.02 gwei is 1.2e13 wei: $0.0288 at 2,400 USD per ETH, 28,800 units of USDG.
    const priced = (expectedProfit: bigint) => {
      const { chain, alerts } = harness();
      vi.mocked(chain.quote).mockResolvedValue({ calldata: '0x1234' as const, expectedProfit });
      vi.mocked(chain.simulate).mockResolvedValue(500_000n);
      vi.mocked(chain.gasPrice).mockResolvedValue(20_000_000n);
      const bot = new Liquidator({ candidates: async () => [candidate] }, chain, alerts, { markets: [market], treasury: market.market, maxCallBatch: 100, minGasBalance: 1n, dryRun: false, ethUsd: 2_400, now: () => 1_000 });
      return { bot, chain };
    };
    const paying = priced(28_801n);
    await paying.bot.cycle();
    expect(paying.chain.submit).toHaveBeenCalledWith(market, candidate, 1_010_000n, expect.anything(), 600_000n, 20_000_000n);
    const losing = priced(28_800n);
    await losing.bot.cycle();
    expect(losing.chain.submit).not.toHaveBeenCalled();
  });

  describe('FeePurchaseUnderfunded', () => {
    const partial: PositionState = { ...unhealthy, debt: 1_000_000_000n, closeFactorBps: 5_000 };
    // As the market reverts: `required` is the cost of the fee leg, `available` what the budget left for it.
    const underfunded = (budget: bigint, repay = 500_000_000n, required = 150_000_000n) =>
      new SimulationRevertedError(encodeErrorResult({ abi: liquidationErrorsAbi, errorName: 'FeePurchaseUnderfunded', args: [required, budget - repay] }));

    it('raises the budget to repay + required when the sizing simulation reverts with it', async () => {
      const { bot, chain } = harness(partial);
      vi.mocked(chain.quote).mockImplementation(async (_market, _candidate, budget) => {
        if (budget < 650_000_000n) throw underfunded(budget);
        return { calldata: '0x1234' as const, expectedProfit: 1_000_000n };
      });
      await bot.cycle();
      expect(vi.mocked(chain.quote).mock.calls.map((call) => call[2])).toEqual([500_000_000n, 650_000_000n]);
      expect(chain.submit).toHaveBeenCalledWith(market, candidate, 650_000_000n, expect.anything(), 120n, 1n);
    });

    it('raises it as well when only the final eth_call reverts with it', async () => {
      const { bot, chain } = harness(partial);
      vi.mocked(chain.simulate).mockImplementation(async (_market, _candidate, budget) => {
        if (budget < 650_000_000n) throw underfunded(budget);
        return 100n;
      });
      await bot.cycle();
      expect(vi.mocked(chain.simulate).mock.calls.map((call) => call[2])).toEqual([500_000_000n, 650_000_000n]);
      expect(chain.submit).toHaveBeenCalledOnce();
    });

    it('counts what the budget already left for the fee leg', async () => {
      const { bot, chain } = harness(partial);
      // The market repays 480 of a 500 budget, so 20 of the 150 are funded: 130 more, not 150.
      vi.mocked(chain.quote).mockImplementation(async (_market, _candidate, budget) => {
        if (budget < 630_000_000n) throw underfunded(budget, 480_000_000n);
        return { calldata: '0x1234' as const, expectedProfit: 1_000_000n };
      });
      await bot.cycle();
      expect(vi.mocked(chain.quote).mock.calls.map((call) => call[2])).toEqual([500_000_000n, 630_000_000n]);
    });

    it('never asks for more than the debt, and never tries one budget twice in a cycle', async () => {
      const { bot, chain } = harness(partial);
      vi.mocked(chain.quote).mockImplementation(async (_market, _candidate, budget) => { throw underfunded(budget, 500_000_000n, 900_000_000n); });
      await bot.cycle();
      expect(vi.mocked(chain.quote).mock.calls.map((call) => call[2])).toEqual([500_000_000n, 1_000_000_000n]);
      expect(chain.submit).not.toHaveBeenCalled();

      const closing = harness({ ...partial, closeFactorBps: 10_000 });
      vi.mocked(closing.chain.quote).mockImplementation(async (_market, _candidate, budget) => { throw underfunded(budget, 1_000_000_000n); });
      await closing.bot.cycle();
      expect(vi.mocked(closing.chain.quote).mock.calls.map((call) => call[2])).toEqual([1_010_000_000n]);
    });
  });

  describe('alert text', () => {
    const failing = async (error: unknown) => {
      const { bot, chain, alerts } = harness();
      vi.mocked(chain.quote).mockRejectedValue(error);
      await bot.cycle();
      await bot.cycle();
      return vi.mocked(alerts.send).mock.calls.map((call) => call[0]);
    };

    it('names the contract error, and the router error inside SwapFailed', async () => {
      const healthy = encodeErrorResult({ abi: liquidationErrorsAbi, errorName: 'PositionIsHealthy', args: [7n, 10n ** 18n] });
      expect(await failing(new SimulationRevertedError(healthy))).toEqual(['liquidation 7 failed 2 times: contract reverted with PositionIsHealthy']);
      const tooLittle = encodeErrorResult({ abi: parseAbi(['error V4TooLittleReceived(uint256,uint256)']), errorName: 'V4TooLittleReceived', args: [2n, 1n] });
      const swapFailed = encodeErrorResult({ abi: helperAbi, errorName: 'SwapFailed', args: [tooLittle] });
      expect(await failing(new SimulationRevertedError(swapFailed))).toEqual(['liquidation 7 failed 2 times: contract reverted with SwapFailed (V4TooLittleReceived)']);
    });

    it('says which route pool is missing', async () => {
      expect(await failing(new RouteUnavailableError('full seizure of 7 needs a route pool other than its own 0xabc'))).toEqual(['liquidation 7 failed 2 times: full seizure of 7 needs a route pool other than its own 0xabc']);
    });

    it('says the indexer is stale, and keeps a provider error to itself', async () => {
      const { chain, alerts } = harness();
      const stale = new Liquidator({ candidates: async () => { throw new IndexerError('indexer is stale; refusing to trust candidate enumeration'); } }, chain, alerts, { markets: [market], treasury: market.market, maxCallBatch: 100, minGasBalance: 1n, dryRun: false, now: () => 1_000 });
      await stale.cycle();
      expect(alerts.send).toHaveBeenCalledWith('liquidator cycle failed: indexer is stale; refusing to trust candidate enumeration');

      const provider = harness();
      vi.mocked(provider.chain.gasBalance).mockRejectedValue(new Error('HTTP request failed. URL: https://paid-rpc.example/v2/secret-key'));
      await provider.bot.cycle();
      expect(provider.alerts.send).toHaveBeenCalledWith('liquidator cycle failed: simulation or execution failed');
    });
  });
});
