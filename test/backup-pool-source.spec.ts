import { describe, expect, it, vi } from 'vitest';
import { ChainLogBackupPoolSource } from '../src/backup-pool-source.js';

const MEME = '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const OTHER_MEME = '0x0000000000000000000000000000000000000000000000000000000000000002' as const;
const BLUE_CHIP = '0x0000000000000000000000000000000000000000000000000000000000000003' as const;
const POLICY = '0x0000000000000000000000000000000000000003' as const;
const POOL_MANAGER = '0x0000000000000000000000000000000000000004' as const;
const RECORDER = '0x0000000000000000000000000000000000000005' as const;
const POLICY_BLOCK = 70_000_000n;
const POOL_MANAGER_BLOCK = 9_070n;
const LATEST = 74_000_000n;
const NOW = 1_800_000_000;

const keyArgs = (id: `0x${string}`) => ({ id, currency0: '0x0000000000000000000000000000000000000001', currency1: '0x0000000000000000000000000000000000000002', fee: 3_000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' });

/** A chain with 100 ms blocks unless `secondsPerBlock` says otherwise. */
function chain(logs: { listed: object[]; initialized?: object[]; recorded?: object[] }, secondsPerBlock = 0.1) {
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber?: bigint; blockTag?: string }) => {
    const number = blockNumber ?? LATEST;
    return { number, timestamp: BigInt(Math.floor(NOW - Number(LATEST - number) * secondsPerBlock)) };
  });
  const getLogs = vi.fn(async ({ address }: { address: string }) => {
    if (address === POLICY) return logs.listed;
    if (address === POOL_MANAGER) return logs.initialized ?? [];
    return logs.recorded ?? [];
  });
  return { getBlock, getLogs };
}

const source = (client: ReturnType<typeof chain>) =>
  new ChainLogBackupPoolSource('http://rpc.local', POLICY, POOL_MANAGER, RECORDER, POLICY_BLOCK, POOL_MANAGER_BLOCK, client as never);

const callTo = (client: ReturnType<typeof chain>, address: string) =>
  client.getLogs.mock.calls.map(([call]) => call as { address: string; args?: object; fromBlock: bigint; toBlock: bigint }).find((call) => call.address === address);

describe('ChainLogBackupPoolSource', () => {
  it('filters Initialize and Recorded to listed meme pools and reads Recorded over a bounded recent window', async () => {
    const client = chain({
      listed: [{ args: { poolId: MEME, tier: 2 } }, { args: { poolId: BLUE_CHIP, tier: 1 } }, { args: { poolId: OTHER_MEME, tier: 2 } }],
      initialized: [{ args: keyArgs(MEME) }, { args: keyArgs(OTHER_MEME) }],
    });
    await source(client).staleMemePools(420);

    expect(callTo(client, POLICY)).toMatchObject({ fromBlock: POLICY_BLOCK, toBlock: LATEST });
    expect(callTo(client, POOL_MANAGER)).toMatchObject({ args: { id: [MEME, OTHER_MEME] }, fromBlock: POOL_MANAGER_BLOCK, toBlock: LATEST });
    // 9,000 blocks of 100 ms is exactly the 900-second window.
    expect(callTo(client, RECORDER)).toMatchObject({ args: { poolId: [MEME, OTHER_MEME] }, fromBlock: LATEST - 9_000n, toBlock: LATEST });
  });

  it('widens the Recorded window when blocks are faster than expected', async () => {
    const client = chain({ listed: [{ args: { poolId: MEME, tier: 2 } }], initialized: [{ args: keyArgs(MEME) }] }, 0.03);
    await source(client).staleMemePools(420);
    const fromBlock = callTo(client, RECORDER)!.fromBlock;
    expect(Number(LATEST - fromBlock) * 0.03).toBeGreaterThanOrEqual(900);
  });

  it('selects a pool with no Recorded log in the window and skips one recorded within 420 seconds', async () => {
    const client = chain({
      listed: [{ args: { poolId: MEME, tier: 2 } }, { args: { poolId: OTHER_MEME, tier: 2 } }],
      initialized: [{ args: keyArgs(MEME) }, { args: keyArgs(OTHER_MEME) }],
      recorded: [{ args: { poolId: OTHER_MEME, timestamp: BigInt(NOW - 800) } }, { args: { poolId: OTHER_MEME, timestamp: BigInt(NOW - 300) } }],
    });
    await expect(source(client).staleMemePools(420)).resolves.toEqual([expect.objectContaining({ id: MEME, observationAgeSeconds: null })]);
  });

  it('selects a pool whose newest observation in the window is older than 420 seconds', async () => {
    const client = chain({
      listed: [{ args: { poolId: MEME, tier: 2 } }],
      initialized: [{ args: keyArgs(MEME) }],
      recorded: [{ args: { poolId: MEME, timestamp: BigInt(NOW - 421) } }],
    });
    await expect(source(client).staleMemePools(420)).resolves.toEqual([expect.objectContaining({ id: MEME, observationAgeSeconds: 421 })]);
  });

  it('reads no pool keys or observations when no meme pool is listed', async () => {
    const client = chain({ listed: [{ args: { poolId: BLUE_CHIP, tier: 1 } }] });
    await expect(source(client).staleMemePools(420)).resolves.toEqual([]);
    expect(client.getLogs).toHaveBeenCalledTimes(1);
  });

  it('refuses a threshold the Recorded window cannot measure', async () => {
    await expect(source(chain({ listed: [] })).staleMemePools(900)).rejects.toThrow('below the 900s Recorded window');
  });
});
