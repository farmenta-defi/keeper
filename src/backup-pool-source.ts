import { createPublicClient, http, parseAbiItem, type Chain } from 'viem';
import type { Address, BackupPoolSource, PoolId, PoolKey } from './types.js';
import { retryWithBackoff } from './retry.js';

const chain: Chain = { id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.robinhoodchain.com'] } } };
const poolListed = parseAbiItem('event PoolListed(bytes32 indexed poolId, uint8 tier, (uint16 maxLtvBps,uint16 ltBps,uint16 liquidatorBonusBps,uint16 removeHaircutBps,uint128 debtCapUsdg,uint128 minPositionUsd) params)');
const initialize = parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
const recorded = parseAbiItem('event Recorded(bytes32 indexed poolId, uint16 index, uint64 timestamp, int56 tickCumulative)');

export class ChainLogBackupPoolSource implements BackupPoolSource {
  private readonly client;
  constructor(rpcUrl: string, private readonly policy: Address, private readonly poolManager: Address, private readonly recorder: Address, private readonly fromBlock: bigint) {
    this.client = createPublicClient({ chain, transport: http(rpcUrl) });
  }

  async staleMemePools(minimumAgeSeconds: number): Promise<PoolKey[]> {
    const [listed, initialized, recordings] = await Promise.all([
      retryWithBackoff(() => this.client.getLogs({ address: this.policy, event: poolListed, fromBlock: this.fromBlock })),
      retryWithBackoff(() => this.client.getLogs({ address: this.poolManager, event: initialize, fromBlock: this.fromBlock })),
      retryWithBackoff(() => this.client.getLogs({ address: this.recorder, event: recorded, fromBlock: this.fromBlock })),
    ]);
    const memeIds = new Set(listed.filter((log) => Number(log.args.tier) === 2).map((log) => log.args.poolId as PoolId));
    const keys = new Map<PoolId, PoolKey>();
    for (const log of initialized) {
      const { id, currency0, currency1, fee, tickSpacing, hooks } = log.args;
      if (!id || !memeIds.has(id) || !currency0 || !currency1 || fee === undefined || tickSpacing === undefined || !hooks) continue;
      keys.set(id, { id, currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks, observationAgeSeconds: null });
    }
    const latestByPool = new Map<PoolId, number>();
    for (const log of recordings) {
      const id = log.args.poolId as PoolId | undefined;
      if (id) latestByPool.set(id, Math.max(latestByPool.get(id) ?? 0, Number(log.args.timestamp ?? 0)));
    }
    const now = Math.floor(Date.now() / 1_000);
    return [...keys.values()].flatMap((key) => {
      const latest = latestByPool.get(key.id) ?? 0;
      return latest === 0 || now - latest > minimumAgeSeconds ? [{ ...key, observationAgeSeconds: latest === 0 ? null : now - latest }] : [];
    });
  }
}
