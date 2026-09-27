import { createPublicClient, createWalletClient, http, parseAbi, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { retryWithBackoff } from './retry.js';
import type { Address, PoolId, PoolKey, Receipt, Recorder } from './types.js';

const chain: Chain = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.robinhoodchain.com'] } },
};

const recorderAbi = parseAbi([
  'function recordBatch((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)[] keys)',
  'function observationCount(bytes32 poolId) view returns (uint16)',
]);
const marketAbi = parseAbi(['function debtOf(uint256 tokenId) view returns (uint256)']);

export class ViemRecorder implements Recorder {
  private readonly publicClient;
  private readonly walletClient;

  constructor(rpcUrl: string, privateKey: Hex, private readonly recorder: Address, private readonly multicall3: Address) {
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    this.walletClient = createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport: http(rpcUrl) });
  }

  async debts(market: Address, tokenIds: bigint[]) {
    return retryWithBackoff(async () => (await this.publicClient.multicall({
      multicallAddress: this.multicall3,
      contracts: tokenIds.map((tokenId) => ({ address: market, abi: marketAbi, functionName: 'debtOf', args: [tokenId] })),
      allowFailure: false,
    })).map((debt) => debt as bigint));
  }

  async observationCounts(poolIds: PoolId[]) {
    return retryWithBackoff(async () => (await this.publicClient.multicall({
      multicallAddress: this.multicall3,
      contracts: poolIds.map((poolId) => ({ address: this.recorder, abi: recorderAbi, functionName: 'observationCount', args: [poolId] })),
      allowFailure: false,
    })).map((count) => Number(count)));
  }

  async submitBatch(pools: PoolKey[]) {
    const nonce = await retryWithBackoff(() => this.publicClient.getTransactionCount({ address: this.walletClient.account.address, blockTag: 'pending' }));
    return retryWithBackoff(async () => this.walletClient.writeContract({
      address: this.recorder,
      abi: recorderAbi,
      functionName: 'recordBatch',
      args: [pools.map(({ currency0, currency1, fee, tickSpacing, hooks }) => ({ currency0, currency1, fee, tickSpacing, hooks }))],
      nonce,
    }));
  }

  async waitForReceipt(hash: string): Promise<Receipt> {
    const receipt = await retryWithBackoff(() => this.publicClient.waitForTransactionReceipt({ hash: hash as Hex, timeout: 60_000 }));
    if (receipt.status !== 'success') throw new Error(`recordBatch reverted: ${hash}`);
    return { hash, gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice };
  }
}
