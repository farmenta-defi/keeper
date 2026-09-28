import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Candidate, Chain, MarketAddresses, PositionState, SwapRoute } from './types.js';

const lensAbi = parseAbi([
  'function liquidationHealthFactor(uint256 tokenId) view returns (uint256)',
  'function liquidationCloseFactorBps(uint256 tokenId) view returns (uint16)',
]);
const marketAbi = parseAbi(['function debtOf(uint256 tokenId) view returns (uint256)', 'function asset() view returns (address)']);
const policyAbi = parseAbi(['function listingOf(bytes32 poolId) view returns (bool,bool,uint8,uint16,uint16,uint16,uint40,uint40,uint16,uint16,uint128,uint128)']);
const helperAbi = parseAbi(['function execute(uint256 tokenId, uint256 repayAmount, bytes swapCalldata)']);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);

interface RouteResponse { calldata: Hex; expectedProfit: string; requiredRepayAmount?: string }

/** The route API is deliberately narrow: it is the only component that speaks to V4Quoter. */
class V4RouteApi {
  constructor(private readonly url: string, private readonly fetcher: typeof fetch = fetch) {}

  async quote(candidate: Candidate, repayAmount: bigint): Promise<SwapRoute> {
    const response = await this.fetcher(`${this.url}/v4-quote`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ market: candidate.market, tokenId: candidate.tokenId.toString(), poolId: candidate.poolId, repayAmount: repayAmount.toString() }),
    });
    if (!response.ok) throw new Error(`V4Quoter route request failed: ${response.status}`);
    const route = await response.json() as RouteResponse;
    if (!route.calldata?.startsWith('0x')) throw new Error('V4Quoter route response lacks UniversalRouter calldata');
    return { calldata: route.calldata, expectedProfit: BigInt(route.expectedProfit), requiredRepayAmount: route.requiredRepayAmount === undefined ? undefined : BigInt(route.requiredRepayAmount) };
  }
}

export class ViemChain implements Chain {
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;
  private readonly routes: V4RouteApi;

  constructor(rpcUrl: string, privateKey: Hex, routeApiUrl: string, chainId: number) {
    this.account = privateKeyToAccount(privateKey);
    const transport = http(rpcUrl);
    const chain = defineChain({ id: chainId, name: 'Farmenta RPC', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
    this.routes = new V4RouteApi(routeApiUrl);
  }

  async positions(market: MarketAddresses, candidates: Candidate[]): Promise<Map<bigint, PositionState>> {
    if (candidates.length === 0) return new Map();
    const calls = candidates.flatMap((candidate) => [
      { address: market.lens, abi: lensAbi, functionName: 'liquidationHealthFactor' as const, args: [candidate.tokenId] },
      { address: market.lens, abi: lensAbi, functionName: 'liquidationCloseFactorBps' as const, args: [candidate.tokenId] },
      { address: market.market, abi: marketAbi, functionName: 'debtOf' as const, args: [candidate.tokenId] },
      { address: market.policy, abi: policyAbi, functionName: 'listingOf' as const, args: [candidate.poolId] },
    ]);
    const results = await this.publicClient.multicall({ contracts: calls, allowFailure: false });
    const now = Math.floor(Date.now() / 1_000);
    const states = new Map<bigint, PositionState>();
    for (let index = 0; index < candidates.length; index += 1) {
      const offset = index * 4;
      const listing = results[offset + 3] as unknown as readonly [boolean, boolean, number, number, number, number, number, number, number, number, bigint, bigint];
      const rampStartsAt = listing[6];
      const rampEndsAt = rampStartsAt + listing[7];
      states.set(candidates[index]!.tokenId, {
        healthFactor: results[offset] as bigint, closeFactorBps: Number(results[offset + 1]), debt: results[offset + 2] as bigint,
        rampStartsAt, rampEndsAt: rampEndsAt > now ? rampEndsAt : 0,
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
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('liquidation transaction reverted');
  }

  async sweep(market: MarketAddresses, treasury: Address): Promise<Hex | undefined> {
    const asset = await this.publicClient.readContract({ address: market.market, abi: marketAbi, functionName: 'asset' });
    const balance = await this.publicClient.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [this.account.address] });
    if (balance === 0n) return undefined;
    return this.walletClient.writeContract({ address: asset, abi: erc20Abi, functionName: 'transfer', args: [treasury, balance] });
  }

  gasBalance(): Promise<bigint> { return this.publicClient.getBalance({ address: this.account.address }); }
}
