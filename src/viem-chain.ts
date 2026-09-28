import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeAbiParameters, encodeFunctionData, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { lensAbi, marketAbi, policyAbi, recorderAbi } from './contract-abi.js';
import { RouteUnavailableError } from './errors.js';
import { executeAbi, revertOf, SimulationRevertedError } from './revert.js';
import type { Address, Candidate, Chain, MarketAddresses, PoolKey, PositionState, SwapRoute } from './types.js';
import type { RpcCostLedger } from './rpc-cost.js';

// Farmenta's ABIs are generated from the pinned contracts (src/contract-abi.ts). These are the
// external contracts: ERC-20, and Uniswap's V4Quoter and UniversalRouter as deployed (spec §4.7).
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'event Transfer(address indexed from, address indexed to, uint256 value)']);
const quoterAbi = parseAbi(['function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) returns (uint256,uint256)']);
const routerAbi = parseAbi(['function execute(bytes,bytes[],uint256) payable']);
const OPEN_DELTA = 0n;
const CONTRACT_BALANCE = 1n << 255n;
const BPS = 10_000n;
const MEME_TIER = 2;
const DEADLINE_SECONDS = 30n;

interface SimulatedLog { address: string; topics: Hex[]; data: Hex }
export interface SimulatedCall { status: Hex; returnData?: Hex; logs?: SimulatedLog[]; error?: { data?: Hex } }
interface SimulatedBlock { calls?: SimulatedCall[] }

/** What one simulated `LiquidatorHelper.execute` did, read from its logs. */
export interface Seizure { out0: bigint; out1: bigint; fullSeizure: boolean; profit: bigint }

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/**
 * Reads the market's `Liquidate` and the USDG the helper paid `bot` out of one `eth_simulateV1`
 * call result. A reverted call carries its revert data out as `SimulationRevertedError`.
 */
export function readSeizure(call: SimulatedCall | undefined, addresses: { market: Address; helper: Address; usdg: Address; bot: Address }): Seizure {
  if (!call) throw new Error('eth_simulateV1 returned no call result');
  if (call.status !== '0x1') throw new SimulationRevertedError(call.error?.data ?? call.returnData ?? '0x');
  let liquidation: Omit<Seizure, 'profit'> | undefined;
  let profit = 0n;
  for (const log of call.logs ?? []) {
    const topics = log.topics as [Hex, ...Hex[]];
    try {
      if (same(log.address, addresses.market)) {
        const event = decodeEventLog({ abi: marketAbi, eventName: 'Liquidate', topics, data: log.data });
        liquidation = { out0: event.args.out0, out1: event.args.out1, fullSeizure: event.args.fullSeizure };
      } else if (same(log.address, addresses.usdg)) {
        const event = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', topics, data: log.data });
        if (same(event.args.from, addresses.helper) && same(event.args.to, addresses.bot)) profit += event.args.value;
      }
    } catch { /* Another event of the same contract. */ }
  }
  if (!liquidation) throw new Error('liquidation simulation succeeded without a Liquidate event');
  return { ...liquidation, profit };
}

class V4RouteBuilder {
  constructor(private readonly client: ReturnType<typeof createPublicClient>, private readonly quoter: Address, private readonly usdg: Address) {}

  /** The token a liquidation of this pool's position leaves to sell. Every listed pool quotes in USDG (spec §1). */
  seizedCurrency(own: PoolKey): Address {
    if (same(own.currency0, this.usdg)) return own.currency1;
    if (same(own.currency1, this.usdg)) return own.currency0;
    throw new RouteUnavailableError(`pool ${own.id} does not contain USDG`);
  }

  /** Pools that sell the seized token for USDG: the configured ones first, then the position's own. */
  candidates(configured: PoolKey[], own: PoolKey): PoolKey[] {
    const seized = this.seizedCurrency(own);
    const sellsSeized = (key: PoolKey) => (same(key.currency0, seized) && same(key.currency1, this.usdg)) || (same(key.currency1, seized) && same(key.currency0, this.usdg));
    return [...configured, own].filter(sellsSeized).filter((key, index, all) => all.findIndex((other) => same(other.id, key.id)) === index);
  }

  async deadline(): Promise<bigint> {
    return (await this.client.getBlock({ blockTag: 'latest' })).timestamp + DEADLINE_SECONDS;
  }

  async quote(key: PoolKey, amountIn: bigint): Promise<bigint> {
    const zeroForOne = same(key.currency1, this.usdg);
    const { result } = await this.client.simulateContract({ address: this.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [[[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], zeroForOne, amountIn, '0x']] });
    return result[0];
  }

  /**
   * Sells whatever the helper pushed to the router: SETTLE the router's balance, swap the open
   * delta, TAKE_ALL USDG with a floor (spec §4.7). The calldata carries no input amount.
   */
  swap(key: PoolKey, minOut: bigint, deadline: bigint): Hex {
    const zeroForOne = same(key.currency1, this.usdg);
    const input = zeroForOne ? key.currency0 : key.currency1;
    const params = encodeAbiParameters([{ type: 'tuple', components: [{ type: 'tuple', name: 'poolKey', components: [{ type: 'address', name: 'currency0' }, { type: 'address', name: 'currency1' }, { type: 'uint24', name: 'fee' }, { type: 'int24', name: 'tickSpacing' }, { type: 'address', name: 'hooks' }] }, { type: 'bool', name: 'zeroForOne' }, { type: 'uint128', name: 'amountIn' }, { type: 'uint128', name: 'amountOutMinimum' }, { type: 'uint256', name: 'minHopPriceX36' }, { type: 'bytes', name: 'hookData' }] }], [{ poolKey: { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks }, zeroForOne, amountIn: OPEN_DELTA, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }]);
    const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [input, CONTRACT_BALANCE, false]);
    const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [this.usdg, minOut]);
    const swapInput = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x0b060f', [settle, params, take]]);
    return encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: ['0x10', [swapInput], deadline] });
  }

  /** For a seizure that is USDG only: a swap of nothing reverts, so the router is given no command. */
  noSwap(deadline: bigint): Hex {
    return encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: ['0x', [], deadline] });
  }
}

export interface ViemChainOptions {
  rpcUrl: string;
  privateKey: Hex;
  chainId: number;
  /** Uniswap's V4Quoter. The router is not here: the helper holds its address, the bot only writes its calldata. */
  quoter: Address;
  usdg: Address;
  multicall3: Address;
  /** Without it no pool is ever read as stale. */
  recorder?: Address;
  costs?: RpcCostLedger;
  /** Floor of the swap against its quote, in basis points. */
  slippageBps?: number;
  rpcTimeoutMs?: number;
}

export class ViemChain implements Chain {
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;
  private readonly routes: V4RouteBuilder;
  private readonly usdg: Address;
  private readonly multicall3: Address;
  private readonly recorder: Address | undefined;
  private readonly slippageBps: number;

  constructor({ rpcUrl, privateKey, chainId, quoter, usdg, multicall3, recorder, costs, slippageBps = 50, rpcTimeoutMs = 10_000 }: ViemChainOptions) {
    this.usdg = usdg;
    this.multicall3 = multicall3;
    this.recorder = recorder;
    this.slippageBps = slippageBps;
    this.account = privateKeyToAccount(privateKey);
    const transport = http(rpcUrl, { timeout: rpcTimeoutMs, onFetchRequest: () => { costs?.record(); } });
    const chain = defineChain({ id: chainId, name: 'Farmenta RPC', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } }, contracts: { multicall3: { address: multicall3, blockCreated: 0 } } });
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
    this.routes = new V4RouteBuilder(this.publicClient, quoter, usdg);
  }

  async positions(market: MarketAddresses, candidates: Candidate[]): Promise<Map<bigint, PositionState>> {
    if (candidates.length === 0) return new Map();
    const width = this.recorder ? 6 : 5;
    const calls = candidates.flatMap((candidate) => [
      { address: market.lens, abi: lensAbi, functionName: 'liquidationHealthFactor' as const, args: [candidate.tokenId] },
      { address: market.lens, abi: lensAbi, functionName: 'liquidationCloseFactorBps' as const, args: [candidate.tokenId] },
      { address: market.market, abi: marketAbi, functionName: 'debtOf' as const, args: [candidate.tokenId] },
      { address: market.market, abi: marketAbi, functionName: 'loanOf' as const, args: [candidate.tokenId] },
      { address: market.policy, abi: policyAbi, functionName: 'listingOf' as const, args: [candidate.poolId] },
      ...(this.recorder ? [{ address: this.recorder, abi: recorderAbi, functionName: 'consult' as const, args: [candidate.poolId, 1_800] as const }] : []),
    ]);
    const results = await this.publicClient.multicall({ contracts: calls, allowFailure: true, multicallAddress: this.multicall3 });
    const now = Math.floor(Date.now() / 1_000);
    const states = new Map<bigint, PositionState>();
    for (let index = 0; index < candidates.length; index += 1) {
      const values = results.slice(index * width, (index + 1) * width);
      if (values.slice(0, 5).some((result) => result.status === 'failure')) continue;
      const loan = values[3]!.result as unknown as { tier: number; poolKeyId: Hex };
      if (!same(loan.poolKeyId, candidates[index]!.poolId)) continue;
      const listing = values[4]!.result as unknown as { rampStart: number; rampDuration: number };
      const rampEndsAt = listing.rampStart + listing.rampDuration;
      states.set(candidates[index]!.tokenId, {
        healthFactor: values[0]!.result as bigint, closeFactorBps: Number(values[1]!.result), debt: values[2]!.result as bigint,
        rampStartsAt: listing.rampStart, rampEndsAt: rampEndsAt > now ? rampEndsAt : 0,
        // `consult` reverts for every pool that was never recorded, which is every Blue-chip pool:
        // only a meme loan, by the tier the market holds, can be stale (spec §13).
        stale: width === 6 && loan.tier === MEME_TIER && values[5]!.status === 'failure',
      });
    }
    return states;
  }

  /**
   * Sizes the route from a simulated liquidation rather than from `repayAmount` (spec §4.7): the
   * seizure is a USDG leg and another leg, and the flash loan carries the protocol fee, so neither
   * the amount to sell nor the profit follows from the budget.
   */
  async quote(market: MarketAddresses, candidate: Candidate, repayAmount: bigint): Promise<SwapRoute> {
    const own = candidate.poolKey;
    if (!own) throw new RouteUnavailableError(`pool key ${candidate.poolId} is unavailable from the indexer`);
    const pools = this.routes.candidates(market.routePools ?? [], own);
    const deadline = await this.routes.deadline();
    const noSwap = this.routes.noSwap(deadline);

    // 1. What is seized. The route has no floor and tries pool after pool: after a full seizure
    // the position's own pool can be left without liquidity, and a swap there settles nothing.
    let measured: Seizure | undefined;
    let swapFailure: unknown;
    for (const calldata of [...pools.map((key) => this.routes.swap(key, 0n, deadline)), noSwap]) {
      try {
        measured = await this.seizure(market, candidate, repayAmount, calldata);
        break;
      } catch (error) {
        if (revertOf(error)?.errorName !== 'SwapFailed') throw error;
        swapFailure = error;
      }
    }
    if (!measured) throw swapFailure;
    const seized = same(own.currency0, this.usdg) ? measured.out1 : measured.out0;
    if (seized === 0n) return { calldata: noSwap, expectedProfit: measured.profit };

    // 2. Where to sell it. Quotes run against the state before the seizure, so after a full
    // seizure the position's own pool would quote liquidity that will no longer be there.
    const eligible = measured.fullSeizure ? pools.filter((key) => !same(key.id, own.id)) : pools;
    if (eligible.length === 0) throw new RouteUnavailableError(`full seizure of ${candidate.tokenId} needs a route pool other than its own ${own.id}`);
    let best: { key: PoolKey; amountOut: bigint } | undefined;
    for (const key of eligible) {
      const amountOut = await this.routes.quote(key, seized).catch(() => 0n);
      if (amountOut > (best?.amountOut ?? 0n)) best = { key, amountOut };
    }
    if (!best) throw new RouteUnavailableError(`no route pool quotes the seized token of ${own.id}`);
    const minOut = best.amountOut * (BPS - BigInt(this.slippageBps)) / BPS;
    const calldata = this.routes.swap(best.key, minOut, deadline);

    // 3. What it pays: the USDG the helper sends the bot with the final route, less what the
    // floor still lets the swap lose.
    const { profit } = await this.seizure(market, candidate, repayAmount, calldata);
    const tolerated = best.amountOut - minOut;
    return { calldata, expectedProfit: profit > tolerated ? profit - tolerated : 0n };
  }

  async simulate(market: MarketAddresses, candidate: Candidate, repayAmount: bigint, route: SwapRoute): Promise<bigint> {
    const simulation = await this.publicClient.simulateContract({ account: this.account, address: market.helper, abi: executeAbi, functionName: 'execute', args: [candidate.tokenId, repayAmount, route.calldata] });
    return await this.publicClient.estimateContractGas(simulation.request);
  }

  private async seizure(market: MarketAddresses, candidate: Candidate, repayAmount: bigint, swapCalldata: Hex): Promise<Seizure> {
    const data = encodeFunctionData({ abi: executeAbi, functionName: 'execute', args: [candidate.tokenId, repayAmount, swapCalldata] });
    const blocks = await this.publicClient.request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [{ from: this.account.address, to: market.helper, data }] }], validation: false }, 'latest'] } as never) as SimulatedBlock[];
    return readSeizure(blocks[0]?.calls?.[0], { market: market.market, helper: market.helper, usdg: this.usdg, bot: this.account.address });
  }

  gasPrice(): Promise<bigint> { return this.publicClient.getGasPrice(); }

  async submit(market: MarketAddresses, candidate: Candidate, repayAmount: bigint, route: SwapRoute, gas: bigint, maxFeePerGas: bigint): Promise<Hex> {
    return this.walletClient.writeContract({ address: market.helper, abi: executeAbi, functionName: 'execute', args: [candidate.tokenId, repayAmount, route.calldata], gas, maxFeePerGas });
  }

  async waitForReceipt(hash: Hex): Promise<void> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') throw new Error('liquidation transaction reverted');
  }

  async sweep(market: MarketAddresses, treasury: Address): Promise<Hex | undefined> {
    const asset = await this.publicClient.readContract({ address: market.market, abi: marketAbi, functionName: 'asset' });
    const balance = await this.publicClient.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [this.account.address] });
    if (balance === 0n) return undefined;
    const hash = await this.walletClient.writeContract({ address: asset, abi: erc20Abi, functionName: 'transfer', args: [treasury, balance] });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') throw new Error('treasury sweep reverted');
    return hash;
  }

  gasBalance(): Promise<bigint> { return this.publicClient.getBalance({ address: this.account.address }); }

  recordPool(poolKey: PoolKey): Promise<Hex> {
    if (!this.recorder) throw new Error('KEEPER_TWAP_RECORDER is required for stale pool recovery');
    return this.walletClient.writeContract({ address: this.recorder, abi: recorderAbi, functionName: 'record', args: [{ currency0: poolKey.currency0, currency1: poolKey.currency1, fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks }] });
  }
}
