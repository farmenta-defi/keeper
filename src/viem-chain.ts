import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodeFunctionData, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Candidate, Chain, MarketAddresses, PoolKey, PositionState, SwapRoute } from './types.js';
import type { RpcCostLedger } from './rpc-cost.js';

const lensAbi = parseAbi([
  'function liquidationHealthFactor(uint256 tokenId) view returns (uint256)',
  'function liquidationCloseFactorBps(uint256 tokenId) view returns (uint16)',
]);
const marketAbi = parseAbi(['function debtOf(uint256 tokenId) view returns (uint256)', 'function asset() view returns (address)', 'function loanOf(uint256 tokenId) view returns (address owner, uint8 tier, uint256 debtShares, bytes32 poolKeyId)']);
const policyAbi = parseAbi(['function listingOf(bytes32 poolId) view returns (bool,bool,uint8,uint16,uint16,uint16,uint40,uint40,uint16,uint16,uint128,uint128)']);
const helperAbi = parseAbi(['function execute(uint256 tokenId, uint256 repayAmount, bytes swapCalldata)', 'error FeePurchaseUnderfunded(uint256 required,uint256 available)', 'error PositionIsHealthy()', 'error SwapFailed(bytes4)']);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
const quoterAbi = parseAbi(['function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) returns (uint256,uint256)']);
const routerAbi = parseAbi(['function execute(bytes,bytes[],uint256) payable']);
const recorderAbi = parseAbi(['function consult(bytes32,uint32) view returns (int24)', 'function record((address,address,uint24,int24,address))']);
const OPEN_DELTA = 0n;
const CONTRACT_BALANCE = 1n << 255n;
const USDG_TO_18_DECIMAL_INPUT = 1_000_000_000_000n;

class V4RouteBuilder {
  constructor(private readonly client: ReturnType<typeof createPublicClient>, private readonly quoter: Address, private readonly router: Address, private readonly usdg: Address) {}

  async quote(candidate: Candidate, repayAmount: bigint): Promise<SwapRoute> {
    const key = candidate.poolKey;
    if (!key) throw new Error(`pool key ${candidate.poolId} is unavailable from indexer`);
    const usd = this.usdg.toLowerCase();
    const zeroForOne = key.currency1.toLowerCase() === usd;
    if (!zeroForOne && key.currency0.toLowerCase() !== usd) throw new Error('liquidation pool does not contain USDG');
    const input = zeroForOne ? key.currency0 : key.currency1;
    if (input.toLowerCase() === usd) throw new Error('liquidation route cannot swap USDG into USDG');
    const quoteInput = repayAmount * USDG_TO_18_DECIMAL_INPUT;
    const quote = await this.client.simulateContract({ address: this.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [[[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], zeroForOne, quoteInput, '0x']] });
    const [amountOut] = quote.result as readonly [bigint, bigint];
    const minOut = amountOut * 9_950n / 10_000n;
    const params = encodeAbiParameters([{ type: 'tuple', components: [{ type: 'tuple', name: 'poolKey', components: [{ type: 'address', name: 'currency0' }, { type: 'address', name: 'currency1' }, { type: 'uint24', name: 'fee' }, { type: 'int24', name: 'tickSpacing' }, { type: 'address', name: 'hooks' }] }, { type: 'bool', name: 'zeroForOne' }, { type: 'uint128', name: 'amountIn' }, { type: 'uint128', name: 'amountOutMinimum' }, { type: 'uint256', name: 'minHopPriceX36' }, { type: 'bytes', name: 'hookData' }] }], [{ poolKey: { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks }, zeroForOne, amountIn: OPEN_DELTA, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }]);
    const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [input, CONTRACT_BALANCE, false]);
    const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [this.usdg, minOut]);
    const swapInput = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x0b060f' as Hex, [settle, params, take]]);
    const block = await this.client.getBlock({ blockTag: 'latest' });
    const calldata = encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: ['0x10' as Hex, [swapInput], block.timestamp + 30n] });
    return { calldata, expectedProfit: amountOut > repayAmount ? amountOut - repayAmount : 0n };
  }
}

export class ViemChain implements Chain {
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;
  private readonly routes: V4RouteBuilder;

  constructor(rpcUrl: string, privateKey: Hex, chainId: number, quoter: Address, router: Address, usdg: Address, private readonly costs?: RpcCostLedger, private readonly multicall3: Address = '0xca11bde05977b3631167028862be2a173976ca11', private readonly recorder?: Address) {
    this.account = privateKeyToAccount(privateKey);
    const transport = http(rpcUrl, { timeout: 10_000, onFetchRequest: () => { this.costs?.record(); } });
    const chain = defineChain({ id: chainId, name: 'Farmenta RPC', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } }, contracts: { multicall3: { address: this.multicall3, blockCreated: 0 } } });
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
    this.routes = new V4RouteBuilder(this.publicClient, quoter, router, usdg);
  }

  async positions(market: MarketAddresses, candidates: Candidate[]): Promise<Map<bigint, PositionState>> {
    if (candidates.length === 0) return new Map();
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
      const width = this.recorder ? 6 : 5;
      const offset = index * width;
      const values = results.slice(offset, offset + width);
      if (values.slice(0, 5).some((result) => result.status === 'failure')) continue;
      const loan = values[3]!.result as unknown as readonly [Address, number, bigint, `0x${string}`];
      if (loan[3].toLowerCase() !== candidates[index]!.poolId.toLowerCase()) continue;
      const listing = values[4]!.result as unknown as readonly [boolean, boolean, number, number, number, number, number, number, number, number, bigint, bigint];
      const rampStartsAt = listing[6];
      const rampEndsAt = rampStartsAt + listing[7];
      states.set(candidates[index]!.tokenId, {
        healthFactor: values[0]!.result as bigint, closeFactorBps: Number(values[1]!.result), debt: values[2]!.result as bigint,
        rampStartsAt, rampEndsAt: rampEndsAt > now ? rampEndsAt : 0,
        stale: width === 6 && candidates[index]!.tier === 2 && values[5]!.status === 'failure',
      });
    }
    return states;
  }

  quote(_market: MarketAddresses, candidate: Candidate, repayAmount: bigint): Promise<SwapRoute> { return this.routes.quote(candidate, repayAmount); }

  async simulate(market: MarketAddresses, candidate: Candidate, repayAmount: bigint, route: SwapRoute): Promise<bigint> {
    const simulation = await this.publicClient.simulateContract({ account: this.account, address: market.helper, abi: helperAbi, functionName: 'execute', args: [candidate.tokenId, repayAmount, route.calldata] });
    return await this.publicClient.estimateContractGas(simulation.request);
  }

  gasPrice(): Promise<bigint> { return this.publicClient.getGasPrice(); }

  async submit(market: MarketAddresses, candidate: Candidate, repayAmount: bigint, route: SwapRoute, gas: bigint, maxFeePerGas: bigint): Promise<Hex> {
    return this.walletClient.writeContract({ address: market.helper, abi: helperAbi, functionName: 'execute', args: [candidate.tokenId, repayAmount, route.calldata], gas, maxFeePerGas });
  }

  async waitForReceipt(hash: Hex): Promise<void> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') throw new Error('liquidation transaction reverted');
  }

  async sweep(market: MarketAddresses, treasury: Address): Promise<Hex | undefined> {
    const asset = await this.publicClient.readContract({ address: market.market, abi: marketAbi, functionName: 'asset' });
    const balance = await this.publicClient.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [this.account.address] });
    if (balance === 0n) return undefined;
    return this.walletClient.writeContract({ address: asset, abi: erc20Abi, functionName: 'transfer', args: [treasury, balance] });
  }

  gasBalance(): Promise<bigint> { return this.publicClient.getBalance({ address: this.account.address }); }

  recordPool(poolKey: PoolKey): Promise<Hex> {
    if (!this.recorder) throw new Error('KEEPER_TWAP_RECORDER is required for stale pool recovery');
    return this.walletClient.writeContract({ address: this.recorder, abi: recorderAbi, functionName: 'record', args: [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]] });
  }
}
