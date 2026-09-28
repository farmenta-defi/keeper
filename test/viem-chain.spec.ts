import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult, multicall3Abi, parseAbi, toFunctionSelector, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
// The ABIs the fixtures are encoded with come from the pinned contracts' artifacts, not from the
// code under test: a signature the bot gets wrong decodes nothing here and the test goes red.
import { helperAbi, lensAbi, liquidationErrorsAbi, marketAbi, policyAbi, recorderAbi } from '../src/contract-abi.js';
import { RouteUnavailableError } from '../src/errors.js';
import { describeRevert, revertOf, SimulationRevertedError } from '../src/revert.js';
import type { Candidate, MarketAddresses, PoolKey } from '../src/types.js';
import { readSeizure, ViemChain, type SimulatedCall } from '../src/viem-chain.js';
import { RpcRevert, startJsonRpc, type JsonRpcEndpoint } from './support/json-rpc.js';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as const;
const MEME = '0x00000000000000000000000000000000000000c0' as const;
const QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as const;
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11' as const;
const RECORDER = '0x00000000000000000000000000000000000000ee' as const;
const MARKET = '0x00000000000000000000000000000000000000aa' as const;
const HELPER = '0x00000000000000000000000000000000000000ac' as const;
const BOT_KEY = `0x${'11'.repeat(32)}` as const;
const BOT = privateKeyToAccount(BOT_KEY).address;
const market: MarketAddresses = { market: MARKET, lens: '0x00000000000000000000000000000000000000ab', helper: HELPER, policy: '0x00000000000000000000000000000000000000ad' };

// The fixture pools of the pinned block: the position's dynamic-fee pool and the plain pool.
const own: PoolKey = { id: '0x80399a859416860c92785ff7f994e67ecbcda12d3f0adb75e0c2466b9bfacf30', currency0: ZERO, currency1: USDG, fee: 0x800000, tickSpacing: 1, hooks: '0x78257a554194c3ba10a59357b500788934f34080', observationAgeSeconds: null };
const plain: PoolKey = { id: '0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32', currency0: ZERO, currency1: USDG, fee: 460, tickSpacing: 9, hooks: ZERO, observationAgeSeconds: null };
const memePool: PoolKey = { id: '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6', currency0: MEME, currency1: USDG, fee: 200, tickSpacing: 4, hooks: ZERO, observationAgeSeconds: null };
const candidate: Candidate = { market: MARKET, tokenId: 913_889n, poolId: own.id, tier: 1, poolKey: own };

// Both branches as measured on the fork at block 54,200,000 (spec §4.7, v1.74).
const partial = { repaid: 147_911_684n, out0: 10_822_685_919_429_510n, out1: 128_032_666n, badDebt: 0n, fullSeizure: false, profit: 6_698_091n };
const full = { repaid: 186_335_195n, out0: 24_955_879_657_844_459n, out1: 331_500_696n, badDebt: 0n, fullSeizure: true, profit: 207_222_738n };
type Measured = typeof partial;

const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const swapErrors = parseAbi(['error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)', 'error CurrencyNotSettled()']);
const routerAbi = parseAbi(['function execute(bytes,bytes[],uint256) payable']);
const quoterAbi = parseAbi(['function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) returns (uint256,uint256)']);
const executeWithErrors = [...helperAbi, ...liquidationErrorsAbi] as const;

function log(address: string, topics: readonly Hex[], data: Hex) {
  return { address, topics: [...topics], data, blockNumber: '0x33b2e20', logIndex: '0x0', removed: false };
}
function liquidateLog(measured: Measured, emitter: string = MARKET) {
  return log(emitter, encodeEventTopics({ abi: marketAbi, eventName: 'Liquidate', args: { tokenId: candidate.tokenId, liquidator: HELPER, poolId: own.id } }) as Hex[],
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], [measured.repaid, measured.out0, measured.out1, measured.badDebt, measured.fullSeizure]));
}
function transferLog(from: string, to: string, value: bigint, token: string = USDG) {
  return log(token, encodeEventTopics({ abi: transferAbi, eventName: 'Transfer', args: { from: from as Hex, to: to as Hex } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }], [value]));
}
const succeeded = (measured: Measured): SimulatedCall => ({ status: '0x1', returnData: '0x', logs: [liquidateLog(measured), transferLog(HELPER, BOT, measured.profit)] });
const reverted = (data: Hex): SimulatedCall => ({ status: '0x0', returnData: data, logs: [], error: { data } });
const addresses = { market: MARKET, helper: HELPER, usdg: USDG, bot: BOT };

/** Which pool a route sells through and with what floor, or `none` when the router is given no command. */
function routeOf(swapCalldata: Hex): { fee: number; token: string; minOut: bigint } | 'none' {
  const [commands, inputs] = decodeFunctionData({ abi: routerAbi, data: swapCalldata }).args;
  if (commands === '0x') return 'none';
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]!);
  expect(actions).toBe('0x0b060f');
  const [swap] = decodeAbiParameters([{ type: 'tuple', components: [{ type: 'tuple', name: 'poolKey', components: [{ type: 'address', name: 'currency0' }, { type: 'address', name: 'currency1' }, { type: 'uint24', name: 'fee' }, { type: 'int24', name: 'tickSpacing' }, { type: 'address', name: 'hooks' }] }, { type: 'bool', name: 'zeroForOne' }, { type: 'uint128', name: 'amountIn' }, { type: 'uint128', name: 'amountOutMinimum' }, { type: 'uint256', name: 'minHopPriceX36' }, { type: 'bytes', name: 'hookData' }] }], params[1]!);
  expect(swap.amountIn).toBe(0n);
  return { fee: swap.poolKey.fee, token: swap.poolKey.currency0.toLowerCase(), minOut: swap.amountOutMinimum };
}

describe('readSeizure', () => {
  it('reads the seizure and the profit of the partial branch', () => {
    expect(readSeizure(succeeded(partial), addresses)).toEqual({ out0: partial.out0, out1: partial.out1, fullSeizure: false, profit: partial.profit });
  });

  it('reads the full-seizure flag of a seizure that leaves no bad debt', () => {
    expect(readSeizure(succeeded(full), addresses)).toMatchObject({ fullSeizure: true, profit: full.profit });
  });

  it('counts only USDG the helper sent the bot', () => {
    const call: SimulatedCall = { status: '0x1', logs: [
      liquidateLog(partial),
      transferLog(HELPER, MARKET, 148_651_242n),
      transferLog(MARKET, BOT, 999n),
      transferLog(HELPER, BOT, 5n, MEME),
      transferLog(HELPER, BOT, partial.profit),
    ] };
    expect(readSeizure(call, addresses).profit).toBe(partial.profit);
  });

  it('ignores a Liquidate that another contract emitted', () => {
    expect(() => readSeizure({ status: '0x1', logs: [liquidateLog(partial, HELPER)] }, addresses)).toThrow('without a Liquidate event');
  });

  it('carries the revert data of a reverted call', () => {
    const data = encodeErrorResult({ abi: liquidationErrorsAbi, errorName: 'FeePurchaseUnderfunded', args: [150_000_000n, 0n] });
    const thrown = (() => { try { readSeizure(reverted(data), addresses); } catch (error) { return error; } })();
    expect(thrown).toBeInstanceOf(SimulationRevertedError);
    expect(revertOf(thrown)).toEqual({ errorName: 'FeePurchaseUnderfunded', args: [150_000_000n, 0n] });
  });
});

describe('ViemChain', () => {
  // What the endpoint answers; every test sets what it needs.
  let sizing: (route: ReturnType<typeof routeOf>, repayAmount: bigint) => SimulatedCall;
  let helperCall: (repayAmount: bigint) => Hex;
  let quotes: Record<number, bigint | 'revert'>;
  let views: Record<string, { healthFactor: bigint; debt: bigint; tier: number; poolId: Hex; consult: 'fresh' | 'reverts'; lens?: 'reverts' }>;
  const quoted: { fee: number; token: string; amountIn: bigint }[] = [];
  const simulated: { route: ReturnType<typeof routeOf>; repayAmount: bigint }[] = [];
  let endpoint: JsonRpcEndpoint;

  const selector = {
    healthFactor: toFunctionSelector('liquidationHealthFactor(uint256)'), closeFactor: toFunctionSelector('liquidationCloseFactorBps(uint256)'),
    debtOf: toFunctionSelector('debtOf(uint256)'), loanOf: toFunctionSelector('loanOf(uint256)'),
    listingOf: toFunctionSelector('listingOf(bytes32)'), consult: toFunctionSelector('consult(bytes32,uint32)'),
  };

  function view(callData: Hex): { success: boolean; returnData: Hex } {
    const called = callData.slice(0, 10);
    const argument = `0x${callData.slice(10, 74)}` as Hex;
    const position = views[BigInt(argument).toString()] ?? Object.values(views).find((entry) => entry.poolId === argument)!;
    const ok = (returnData: Hex) => ({ success: true, returnData });
    const failed = (returnData: Hex) => ({ success: false, returnData });
    if (called === selector.healthFactor) return position.lens === 'reverts' ? failed('0x') : ok(encodeFunctionResult({ abi: lensAbi, functionName: 'liquidationHealthFactor', result: position.healthFactor }));
    if (called === selector.closeFactor) return position.lens === 'reverts' ? failed('0x') : ok(encodeFunctionResult({ abi: lensAbi, functionName: 'liquidationCloseFactorBps', result: 5_000 }));
    if (called === selector.debtOf) return ok(encodeFunctionResult({ abi: marketAbi, functionName: 'debtOf', result: position.debt }));
    if (called === selector.loanOf) return ok(encodeFunctionResult({ abi: marketAbi, functionName: 'loanOf', result: { owner: BOT, tier: position.tier, debtShares: 1n, poolKeyId: position.poolId } }));
    if (called === selector.listingOf) return ok(encodeFunctionResult({ abi: policyAbi, functionName: 'listingOf', result: { listed: true, frozen: false, tier: position.tier, maxLtvBps: 6_500, ltStartBps: 7_500, ltTargetBps: 7_500, rampStart: 0, rampDuration: 0, liquidatorBonusBps: 500, removeHaircutBps: 0, debtCapUsdg: 500_000_000_000n, minPositionUsd: 0n } }));
    if (called === selector.consult) return position.consult === 'reverts' ? failed(encodeErrorResult({ abi: recorderAbi, errorName: 'TwapUnavailable' })) : ok(encodeFunctionResult({ abi: recorderAbi, functionName: 'consult', result: -198_599 }));
    throw new Error(`unexpected view ${called}`);
  }

  beforeAll(async () => {
    endpoint = await startJsonRpc(({ method, params }) => {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_estimateGas') return '0x7a120';
      if (method === 'eth_getTransactionCount') return '0x0';
      if (method === 'eth_maxPriorityFeePerGas' || method === 'eth_gasPrice') return '0x1312d00';
      if (method === 'eth_getBlockByNumber') return { number: '0x33b2e20', timestamp: '0x6b49d200', hash: `0x${'1'.repeat(64)}`, parentHash: `0x${'2'.repeat(64)}`, transactions: [], gasLimit: '0x1', gasUsed: '0x0', baseFeePerGas: '0x0', difficulty: '0x0', size: '0x0', logsBloom: `0x${'0'.repeat(512)}`, miner: ZERO, nonce: '0x0000000000000000', extraData: '0x', uncles: [] };
      if (method === 'eth_simulateV1') {
        const { blockStateCalls } = params[0] as { blockStateCalls: [{ calls: [{ from: string; to: string; data: Hex }] }] };
        const call = blockStateCalls[0].calls[0];
        expect(call.from.toLowerCase()).toBe(BOT.toLowerCase());
        expect(call.to.toLowerCase()).toBe(HELPER);
        const [, repayAmount, swapCalldata] = decodeFunctionData({ abi: helperAbi, data: call.data }).args;
        const route = routeOf(swapCalldata);
        simulated.push({ route, repayAmount });
        return [{ number: '0x33b2e21', calls: [sizing(route, repayAmount)] }];
      }
      if (method !== 'eth_call') throw new Error(`unsupported ${method}`);
      const { to, data } = (params as [{ to: string; data: Hex }])[0];
      if (to.toLowerCase() === MULTICALL3) {
        const calls = decodeFunctionData({ abi: multicall3Abi, data }).args![0] as readonly { callData: Hex }[];
        return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: calls.map((call) => view(call.callData)) });
      }
      if (to.toLowerCase() === QUOTER) {
        const [[key, , amountIn]] = decodeFunctionData({ abi: quoterAbi, data }).args;
        quoted.push({ fee: key[2], token: key[0].toLowerCase(), amountIn });
        const answer = quotes[key[2]];
        if (answer === undefined || answer === 'revert') throw new RpcRevert('0x');
        return encodeFunctionResult({ abi: quoterAbi, functionName: 'quoteExactInputSingle', result: [answer, 60_000n] });
      }
      if (to.toLowerCase() === HELPER) return helperCall(decodeFunctionData({ abi: helperAbi, data }).args[1]);
      throw new RpcRevert('0x');
    });
  });
  afterAll(async () => { await endpoint.close(); });
  beforeEach(() => {
    quoted.length = 0;
    simulated.length = 0;
    sizing = () => succeeded(partial);
    helperCall = () => '0x';
    quotes = { 460: 27_316_667n, [0x800000]: 27_162_133n };
    views = {};
  });

  const chain = (slippageBps?: number) => new ViemChain({ rpcUrl: endpoint.url, privateKey: BOT_KEY, chainId: 4663, quoter: QUOTER, usdg: USDG, multicall3: MULTICALL3, recorder: RECORDER, slippageBps });
  const withPools = (...routePools: PoolKey[]): MarketAddresses => ({ ...market, routePools });
  const swapFailed = (inner: 'CurrencyNotSettled') => encodeErrorResult({ abi: helperAbi, errorName: 'SwapFailed', args: [encodeErrorResult({ abi: swapErrors, errorName: inner })] });

  describe('positions', () => {
    it('reads every candidate of a batch, and calls only a meme loan stale', async () => {
      views = {
        '7': { healthFactor: 980_000_000_000_000_000n, debt: 1_000_000_000n, tier: 2, poolId: memePool.id, consult: 'reverts' },
        '8': { healthFactor: 970_000_000_000_000_000n, debt: 2_000_000_000n, tier: 1, poolId: own.id, consult: 'reverts' },
        '9': { healthFactor: 1_200_000_000_000_000_000n, debt: 3_000_000_000n, tier: 2, poolId: plain.id, consult: 'fresh' },
      };
      // The indexer's tier is wrong on purpose: the tier that decides is the one the market holds.
      const candidates: Candidate[] = [
        { market: MARKET, tokenId: 7n, poolId: memePool.id, tier: 1, poolKey: memePool },
        { market: MARKET, tokenId: 8n, poolId: own.id, tier: 2, poolKey: own },
        { market: MARKET, tokenId: 9n, poolId: plain.id, tier: 2, poolKey: plain },
      ];
      const states = await chain().positions(market, candidates);
      expect([...states].map(([tokenId, state]) => [tokenId, state.healthFactor, state.debt, state.closeFactorBps, state.stale])).toEqual([
        [7n, 980_000_000_000_000_000n, 1_000_000_000n, 5_000, true],
        [8n, 970_000_000_000_000_000n, 2_000_000_000n, 5_000, false],
        [9n, 1_200_000_000_000_000_000n, 3_000_000_000n, 5_000, false],
      ]);
    });

    it('leaves out a position whose view reverts or whose pool is not the loan\'s, and keeps the rest', async () => {
      views = {
        '7': { healthFactor: 0n, debt: 1n, tier: 1, poolId: own.id, consult: 'fresh', lens: 'reverts' },
        '8': { healthFactor: 970_000_000_000_000_000n, debt: 2_000_000_000n, tier: 1, poolId: plain.id, consult: 'fresh' },
        '9': { healthFactor: 960_000_000_000_000_000n, debt: 3_000_000_000n, tier: 1, poolId: own.id, consult: 'fresh' },
      };
      const at = (tokenId: bigint, poolKey: PoolKey): Candidate => ({ market: MARKET, tokenId, poolId: poolKey.id, tier: 1, poolKey });
      const states = await chain().positions(market, [at(7n, own), at(8n, own), at(9n, own)]);
      expect([...states.keys()]).toEqual([9n]);
    });
  });

  describe('quote', () => {
    it('sells the seized leg through the better of the route pools and the position\'s pool', async () => {
      const route = await chain().quote(withPools(plain), candidate, 295_823_368n);
      expect(quoted).toEqual([{ fee: 460, token: ZERO, amountIn: partial.out0 }, { fee: 0x800000, token: ZERO, amountIn: partial.out0 }]);
      const minOut = 27_316_667n * 9_950n / 10_000n;
      expect(routeOf(route.calldata)).toEqual({ fee: 460, token: ZERO, minOut });
      // The floor may cost the swap 0.5% of its quote, and the profit is counted without it.
      expect(route.expectedProfit).toBe(partial.profit - (27_316_667n - minOut));
      expect(simulated.map(({ route: simulatedRoute }) => simulatedRoute)).toEqual([{ fee: 460, token: ZERO, minOut: 0n }, { fee: 460, token: ZERO, minOut }]);
    });

    it('takes the floor from KEEPER_SLIPPAGE_BPS', async () => {
      const route = await chain(200).quote(withPools(plain), candidate, 295_823_368n);
      expect(routeOf(route.calldata)).toMatchObject({ minOut: 27_316_667n * 9_800n / 10_000n });
    });

    it('prefers the position\'s own pool when it quotes more', async () => {
      quotes = { 460: 27_000_000n, [0x800000]: 27_400_000n };
      expect(routeOf((await chain().quote(withPools(plain), candidate, 295_823_368n)).calldata)).toMatchObject({ fee: 0x800000 });
    });

    it('does not quote a route pool of another token', async () => {
      await chain().quote(withPools(memePool, plain), candidate, 295_823_368n);
      expect(quoted.map(({ token }) => token)).toEqual([ZERO, ZERO]);
      quoted.length = 0;
      quotes = { 200: 5_000_000n };
      const meme: Candidate = { ...candidate, poolId: memePool.id, tier: 2, poolKey: memePool };
      await chain().quote(withPools(plain), meme, 295_823_368n);
      expect(quoted).toEqual([{ fee: 200, token: MEME, amountIn: partial.out0 }]);
    });

    it('leaves the position\'s pool out after a full seizure, bad debt or not', async () => {
      sizing = () => succeeded(full);
      quotes = { 460: 62_988_912n, [0x800000]: 70_000_000n };
      const route = await chain().quote(withPools(plain), candidate, 258_918_884n);
      expect(quoted).toEqual([{ fee: 460, token: ZERO, amountIn: full.out0 }]);
      expect(routeOf(route.calldata)).toMatchObject({ fee: 460 });
    });

    it('measures a full seizure through a route pool when the position\'s pool cannot settle', async () => {
      sizing = (route) => route !== 'none' && route.fee === 0x800000 ? reverted(swapFailed('CurrencyNotSettled')) : succeeded(full);
      quotes = { 460: 62_988_912n };
      // The position's pool is listed first here, so the first measurement is the one that reverts.
      const route = await chain().quote(withPools(own, plain), candidate, 258_918_884n);
      expect(simulated.map(({ route: simulatedRoute }) => simulatedRoute === 'none' ? 'none' : simulatedRoute.fee)).toEqual([0x800000, 460, 460]);
      expect(routeOf(route.calldata)).toMatchObject({ fee: 460 });
      expect(route.expectedProfit).toBe(full.profit - (62_988_912n - 62_988_912n * 9_950n / 10_000n));
    });

    it('says which pool is missing when a full seizure has only the position\'s pool', async () => {
      sizing = (route) => route === 'none' ? succeeded(full) : reverted(swapFailed('CurrencyNotSettled'));
      const thrown = await chain().quote(withPools(), candidate, 258_918_884n).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(RouteUnavailableError);
      expect((thrown as Error).message).toBe(`full seizure of 913889 needs a route pool other than its own ${own.id}`);
      expect(quoted).toEqual([]);
    });

    it('gives the router no command when the seizure is USDG only', async () => {
      const usdgOnly = { ...partial, out0: 0n, out1: 155_307_268n };
      sizing = (route) => route === 'none' ? succeeded(usdgOnly) : reverted(encodeErrorResult({ abi: helperAbi, errorName: 'SwapFailed', args: ['0xbe8b8507'] }));
      const route = await chain().quote(withPools(plain), candidate, 295_823_368n);
      expect(routeOf(route.calldata)).toBe('none');
      expect(route.expectedProfit).toBe(usdgOnly.profit);
      expect(quoted).toEqual([]);
    });

    it('passes FeePurchaseUnderfunded on with its arguments, and tries no other pool for it', async () => {
      sizing = (_route, repayAmount) => reverted(encodeErrorResult({ abi: liquidationErrorsAbi, errorName: 'FeePurchaseUnderfunded', args: [150_000_000n, repayAmount - 500_000_000n] }));
      const thrown = await chain().quote(withPools(plain), candidate, 500_000_000n).catch((error: unknown) => error);
      expect(revertOf(thrown)).toEqual({ errorName: 'FeePurchaseUnderfunded', args: [150_000_000n, 0n] });
      expect(simulated).toHaveLength(1);
    });

    it('refuses a loan whose pool key the indexer does not have', async () => {
      await expect(chain().quote(market, { ...candidate, poolKey: undefined }, 1n)).rejects.toBeInstanceOf(RouteUnavailableError);
    });
  });

  describe('simulate', () => {
    const route = { calldata: '0x1234' as const, expectedProfit: 0n };

    it('names the market and helper errors of a reverted eth_call', async () => {
      helperCall = () => { throw new RpcRevert(encodeErrorResult({ abi: liquidationErrorsAbi, errorName: 'PositionIsHealthy', args: [913_889n, 10n ** 18n] })); };
      expect(revertOf(await chain().simulate(market, candidate, 1n, route).catch((error: unknown) => error))).toEqual({ errorName: 'PositionIsHealthy', args: [913_889n, 10n ** 18n] });

      const tooLittle = encodeErrorResult({ abi: swapErrors, errorName: 'V4TooLittleReceived', args: [577_594_852_204n, 27_316_667n] });
      helperCall = () => { throw new RpcRevert(encodeErrorResult({ abi: executeWithErrors, errorName: 'SwapFailed', args: [tooLittle] })); };
      const revert = revertOf(await chain().simulate(market, candidate, 1n, route).catch((error: unknown) => error));
      expect(revert?.errorName).toBe('SwapFailed');
      expect(describeRevert(revert!)).toBe('SwapFailed (V4TooLittleReceived)');
    });

    it('returns the gas estimate of a call that passes', async () => {
      await expect(chain().simulate(market, candidate, 1n, route)).resolves.toBe(500_000n);
    });
  });
});
