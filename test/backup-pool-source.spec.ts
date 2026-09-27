import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChainLogBackupPoolSource } from '../src/backup-pool-source.js';

const id = '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const keyArgs = { id, currency0: '0x0000000000000000000000000000000000000001', currency1: '0x0000000000000000000000000000000000000002', fee: 3_000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' };

describe('ChainLogBackupPoolSource', () => {
  afterEach(() => vi.restoreAllMocks());

  it('selects a listed meme pool without Recorded logs for its first observation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 * 1_000);
    const client = { getLogs: vi.fn().mockResolvedValueOnce([{ args: { poolId: id, tier: 2 } }]).mockResolvedValueOnce([{ args: keyArgs }]).mockResolvedValueOnce([]) };
    const source = new ChainLogBackupPoolSource('http://rpc.local', '0x0000000000000000000000000000000000000003', '0x0000000000000000000000000000000000000004', '0x0000000000000000000000000000000000000005', 1n, client as never);
    await expect(source.staleMemePools(420)).resolves.toEqual([expect.objectContaining({ id, observationAgeSeconds: null })]);
    expect(client.getLogs).toHaveBeenCalledTimes(3);
  });

  it('uses the newest Recorded timestamp when deciding whether a pool is stale', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 * 1_000);
    const client = { getLogs: vi.fn().mockResolvedValueOnce([{ args: { poolId: id, tier: 2 } }]).mockResolvedValueOnce([{ args: keyArgs }]).mockResolvedValueOnce([{ args: { poolId: id, timestamp: 999_000n } }, { args: { poolId: id, timestamp: 999_700n } }]) };
    const source = new ChainLogBackupPoolSource('http://rpc.local', '0x0000000000000000000000000000000000000003', '0x0000000000000000000000000000000000000004', '0x0000000000000000000000000000000000000005', 1n, client as never);
    await expect(source.staleMemePools(420)).resolves.toEqual([]);
  });
});
