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
    const listed = await retryWithBackoff(() => this.client.getLogs({ address: this.policy, event: poolListed, fromBlock: this.fromBlock }));
    const memeIds = listed.filter((log) => Number(log.args.tier) === 2).map((log) => log.args.poolId as PoolId);
    const keys = await Promise.all(memeIds.map((id) => this.keyFor(id)));
    const now = Math.floor(Date.now() / 1_000);
    const pools = await Promise.all(keys.map(async (key): Promise<PoolKey | null> => {
      if (!key) return null;
      const logs = await retryWithBackoff(() => this.client.getLogs({ address: this.recorder, event: recorded, args: { poolId: key.id }, fromBlock: this.fromBlock }));
      const latest = logs.reduce((timestamp, log) => Math.max(timestamp, Number(log.args.timestamp ?? 0)), 0);
      return latest > 0 && now - latest > minimumAgeSeconds ? { ...key, observationAgeSeconds: now - latest } : null;
    }));
    return pools.filter((pool): pool is PoolKey => pool !== null);
  }

  private async keyFor(id: PoolId): Promise<PoolKey | null> {
    const logs = await retryWithBackoff(() => this.client.getLogs({ address: this.poolManager, event: initialize, args: { id }, fromBlock: this.fromBlock }));
    const log = logs.at(-1);
    if (!log?.args.currency0 || !log.args.currency1 || log.args.fee === undefined || log.args.tickSpacing === undefined || !log.args.hooks) return null;
    return { id, currency0: log.args.currency0, currency1: log.args.currency1, fee: Number(log.args.fee), tickSpacing: Number(log.args.tickSpacing), hooks: log.args.hooks, observationAgeSeconds: null };
  }
}
