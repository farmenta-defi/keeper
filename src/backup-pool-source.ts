import { createPublicClient, http, parseAbiItem, type Chain } from 'viem';
import type { Address, BackupPoolSource, PoolId, PoolKey } from './types.js';
import { retryWithBackoff } from './retry.js';

const chain: Chain = { id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.robinhoodchain.com'] } } };
const poolListed = parseAbiItem('event PoolListed(bytes32 indexed poolId, uint8 tier, (uint16 maxLtvBps,uint16 ltBps,uint16 liquidatorBonusBps,uint16 removeHaircutBps,uint128 debtCapUsdg,uint128 minPositionUsd) params)');
const initialize = parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
const recorded = parseAbiItem('event Recorded(bytes32 indexed poolId, uint16 index, uint64 timestamp, int56 tickCumulative)');

const MEME_TIER = 2;
// `Recorded` grows by 288 logs per pool per day, so reading its whole history soon exceeds the
// RPC's per-response log cap (spec §13 v1.42). Only a recent window is read; a pool with no
// `Recorded` inside it is older than the window and therefore stale.
export const RECORDED_WINDOW_SECONDS = 900;
const INITIAL_WINDOW_BLOCKS = 9_000n; // 900 s at the chain's 100 ms blocks
const MAX_WINDOW_WIDENINGS = 8;

type Client = Pick<ReturnType<typeof createPublicClient>, 'getBlock' | 'getLogs'>;

export class ChainLogBackupPoolSource implements BackupPoolSource {
  private readonly client: Client;
  constructor(
    rpcUrl: string,
    private readonly policy: Address,
    private readonly poolManager: Address,
    private readonly recorder: Address,
    /** `CollateralPolicy` deployment block: no `PoolListed` or `Recorded` log is older. */
    private readonly fromBlock: bigint,
    /** PoolManager deployment block: a listed pool may have been initialized long before the policy existed. */
    private readonly poolManagerFromBlock: bigint,
    client?: Client,
  ) {
    this.client = client ?? createPublicClient({ chain, transport: http(rpcUrl) });
  }

  async staleMemePools(minimumAgeSeconds: number): Promise<PoolKey[]> {
    if (minimumAgeSeconds >= RECORDED_WINDOW_SECONDS) throw new Error(`Backup threshold must be below the ${RECORDED_WINDOW_SECONDS}s Recorded window`);
    const latest = await retryWithBackoff(() => this.client.getBlock({ blockTag: 'latest' }));
    const toBlock = latest.number;
    const now = Number(latest.timestamp);

    // Listings are few, so they are read from the policy's deployment block.
    const listed = await retryWithBackoff(() => this.client.getLogs({ address: this.policy, event: poolListed, fromBlock: this.fromBlock, toBlock }));
    const tiers = new Map<PoolId, number>();
    for (const log of listed) if (log.args.poolId) tiers.set(log.args.poolId, Number(log.args.tier));
    const memeIds = [...tiers].filter(([, tier]) => tier === MEME_TIER).map(([id]) => id);
    if (memeIds.length === 0) return [];

    const [initialized, recordings] = await Promise.all([
      retryWithBackoff(() => this.client.getLogs({ address: this.poolManager, event: initialize, args: { id: memeIds }, fromBlock: this.poolManagerFromBlock, toBlock })),
      this.windowStart(toBlock, now).then((fromBlock) =>
        retryWithBackoff(() => this.client.getLogs({ address: this.recorder, event: recorded, args: { poolId: memeIds }, fromBlock, toBlock }))),
    ]);

    const keys = new Map<PoolId, PoolKey>();
    for (const log of initialized) {
      const { id, currency0, currency1, fee, tickSpacing, hooks } = log.args;
      if (!id || !currency0 || !currency1 || fee === undefined || tickSpacing === undefined || !hooks) continue;
      keys.set(id, { id, currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks, observationAgeSeconds: null });
    }
    const latestByPool = new Map<PoolId, number>();
    for (const log of recordings) {
      const id = log.args.poolId;
      if (id) latestByPool.set(id, Math.max(latestByPool.get(id) ?? 0, Number(log.args.timestamp ?? 0)));
    }
    return [...keys.values()].flatMap((key): PoolKey[] => {
      const last = latestByPool.get(key.id);
      if (last === undefined) return [{ ...key, observationAgeSeconds: null }];
      const age = now - last;
      return age > minimumAgeSeconds ? [{ ...key, observationAgeSeconds: age }] : [];
    });
  }

  /** First block of a range that covers at least RECORDED_WINDOW_SECONDS, whatever the block time. */
  private async windowStart(toBlock: bigint, now: number): Promise<bigint> {
    let span = INITIAL_WINDOW_BLOCKS;
    for (let widening = 0; widening <= MAX_WINDOW_WIDENINGS; widening += 1) {
      if (span >= toBlock) return this.fromBlock;
      const start = toBlock - span;
      if (start <= this.fromBlock) return this.fromBlock;
      const block = await retryWithBackoff(() => this.client.getBlock({ blockNumber: start }));
      if (now - Number(block.timestamp) >= RECORDED_WINDOW_SECONDS) return start;
      span *= 2n;
    }
    throw new Error(`Could not find a block ${RECORDED_WINDOW_SECONDS}s back from ${toBlock}`);
  }
}
