import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeRevert, revertOf } from '../../src/revert.js';
import { Liquidator } from '../../src/liquidator.js';
import type { MarketAddresses } from '../../src/types.js';
import { ViemChain } from '../../src/viem-chain.js';
import { BOT_KEY, MULTICALL3, PLAIN_POOL, startFarmentaFork, USDG, V4_QUOTER, type FarmentaFork } from './support/farmenta-fork.js';

const forkUrl = process.env.FORK_RPC_URL;
const contracts = process.env.SMART_CONTRACT_DIR;
if (!forkUrl || !contracts) throw new Error('FORK_RPC_URL and SMART_CONTRACT_DIR are required for bun run test:fork');

const WAD = 10n ** 18n;
const TREASURY = '0x00000000000000000000000000000000007EA501' as const;

// The liquidation bot itself against deployed contracts: `Liquidator` and `ViemChain` are the
// ones the process runs. Only the two things that are not the chain are stubbed: the indexer's
// candidate list and Telegram.
describe('liquidation on an Anvil fork', () => {
  let fork: FarmentaFork;
  const alerts = { send: vi.fn(async (_message: string) => undefined) };

  beforeAll(async () => { fork = await startFarmentaFork(forkUrl, contracts, 18_547); });
  afterAll(() => fork?.stop());
  beforeEach(async () => {
    await fork.reset();
    alerts.send.mockClear();
  });

  // Anvil reads the fork's state from the upstream RPC as a call first touches it, so a first
  // simulation can take longer than the bot allows a node that holds the state itself.
  const chain = () => new ViemChain({ rpcUrl: fork.url, privateKey: BOT_KEY, chainId: 4663, quoter: V4_QUOTER, usdg: USDG, multicall3: MULTICALL3, recorder: fork.recorder, rpcTimeoutMs: 120_000 });
  const routed = (): MarketAddresses => ({ ...fork.market, routePools: [PLAIN_POOL] });
  function bot(market: MarketAddresses, options: { dryRun?: boolean; log?: (line: string) => void } = {}) {
    return new Liquidator({ candidates: async () => [fork.candidate] }, chain(), alerts, {
      markets: [market], treasury: TREASURY, maxCallBatch: 100, minGasBalance: 10n ** 16n, ethUsd: 2_400, dryRun: options.dryRun ?? false, log: options.log,
    });
  }

  it('leaves a healthy loan alone', async () => {
    expect(await fork.healthFactor()).toBeGreaterThanOrEqual(WAD);
    const nonce = await fork.nonceOf(fork.bot);
    await bot(routed()).cycle();
    expect(await fork.nonceOf(fork.bot)).toBe(nonce);
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it('prints the plan of a dry run and sends nothing', async () => {
    await fork.dropEthUntilHealthFactor(WAD * 90n / 100n, WAD);
    const [nonce, debt] = [await fork.nonceOf(fork.bot), await fork.debt()];
    const log = vi.fn();
    await bot(routed(), { dryRun: true, log }).cycle();

    expect(log).toHaveBeenCalledOnce();
    const plan = JSON.parse(log.mock.calls[0]![0] as string) as { tokenId: string; repayAmount: string; expectedProfit: string };
    expect(plan.tokenId).toBe(fork.candidate.tokenId.toString());
    // Half the debt: the close factor of a Blue-chip loan with HF in [0.9, 1).
    expect(BigInt(plan.repayAmount)).toBe(debt / 2n);
    expect(BigInt(plan.expectedProfit)).toBeGreaterThan(0n);
    expect(await fork.nonceOf(fork.bot)).toBe(nonce);
    expect(await fork.debt()).toBeGreaterThanOrEqual(debt);
  });

  it('liquidates part of an unhealthy loan and sweeps the profit to the treasury', async () => {
    await fork.dropEthUntilHealthFactor(WAD * 90n / 100n, WAD);
    const debt = await fork.debt();
    await bot(routed()).cycle();

    expect(alerts.send).not.toHaveBeenCalled();
    const repaid = debt - await fork.debt();
    // The close factor is half; interest accrues on the way, so not to the last unit.
    expect(repaid).toBeGreaterThan(debt * 49n / 100n);
    expect(repaid).toBeLessThanOrEqual(debt / 2n);
    expect(await fork.usdgOf(TREASURY)).toBeGreaterThan(0n);
    expect(await fork.usdgOf(fork.bot)).toBe(0n);
    expect(await fork.usdgOf(fork.market.helper)).toBe(0n);
    expect(await fork.holderOfPosition()).toBe(fork.market.market);
  });

  it('seizes a deeply unhealthy loan in full and sells it through the route pool', async () => {
    await fork.setEthPrice(120_000_000_000n);
    expect(await fork.healthFactor()).toBeLessThan(WAD * 90n / 100n);
    await bot(routed()).cycle();

    expect(alerts.send).not.toHaveBeenCalled();
    expect(await fork.debt()).toBe(0n);
    // The position is burned, and with it all the active liquidity of its own pool.
    expect(await fork.holderOfPosition()).toBeUndefined();
    expect(await fork.usdgOf(TREASURY)).toBeGreaterThan(0n);
    expect(await fork.usdgOf(fork.bot)).toBe(0n);
  });

  it('sends nothing for a full seizure when the position\'s own pool is the only route, and says why', async () => {
    await fork.setEthPrice(120_000_000_000n);
    const [nonce, debt] = [await fork.nonceOf(fork.bot), await fork.debt()];
    const alone = bot({ ...fork.market, routePools: [] });
    await alone.cycle();
    await alone.cycle();

    expect(await fork.nonceOf(fork.bot)).toBe(nonce);
    expect(await fork.debt()).toBeGreaterThanOrEqual(debt);
    expect(alerts.send).toHaveBeenCalledWith(`liquidation ${fork.candidate.tokenId} failed 2 times: full seizure of ${fork.candidate.tokenId} needs a route pool other than its own ${fork.candidate.poolId}`);
  });

  it('reverts through the helper when the swap falls under the floor of its route', async () => {
    const price = await fork.dropEthUntilHealthFactor(WAD * 90n / 100n, WAD * 96n / 100n);
    const debt = await fork.debt();
    const live = chain();
    const route = await live.quote(routed(), fork.candidate, debt / 2n);
    await expect(live.simulate(routed(), fork.candidate, debt / 2n, route)).resolves.toBeGreaterThan(0n);

    // ETH is repriced 3% up before the transaction lands: the same repayment seizes less ETH,
    // and the swap of it returns less than the route's floor allows.
    await fork.setEthPrice(price * 103n / 100n);
    expect(await fork.healthFactor()).toBeLessThan(WAD);
    const revert = revertOf(await live.simulate(routed(), fork.candidate, debt / 2n, route).catch((error: unknown) => error));
    expect(revert && describeRevert(revert)).toBe('SwapFailed (V4TooLittleReceived)');

    const nonce = await fork.nonceOf(fork.bot);
    const hash = await live.submit(routed(), fork.candidate, debt / 2n, route, 3_000_000n, await live.gasPrice());
    await expect(live.waitForReceipt(hash)).rejects.toThrow('liquidation transaction reverted');
    expect(await fork.nonceOf(fork.bot)).toBe(nonce + 1);
    expect(await fork.debt()).toBeGreaterThanOrEqual(debt);
    expect(await fork.usdgOf(fork.bot)).toBe(0n);
    expect(await fork.holderOfPosition()).toBe(fork.market.market);
  });
});
