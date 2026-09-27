import { describe, expect, it, vi } from 'vitest';
import { BackupKeeperService, reportBackupFailure } from '../src/backup-service.js';
import type { AlertSink, BackupPoolSource, PoolKey, Recorder } from '../src/types.js';

const stalePool: PoolKey = { id: '0x0000000000000000000000000000000000000000000000000000000000000001', currency0: '0x0000000000000000000000000000000000000001', currency1: '0x0000000000000000000000000000000000000002', fee: 3_000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000', observationAgeSeconds: 421 };

function dependencies(stale: PoolKey[]) {
  const pools: BackupPoolSource = { staleMemePools: vi.fn().mockResolvedValue(stale) };
  const recorder: Recorder = { debts: vi.fn(), observationCounts: vi.fn(), submitBatch: vi.fn().mockResolvedValue('0xbackup'), waitForReceipt: vi.fn().mockResolvedValue({ hash: '0xbackup', gasUsed: 100n, gasPrice: 1_000_000_000n }) };
  const alerts: AlertSink = { send: vi.fn() };
  return { pools, recorder, alerts };
}

describe('BackupKeeperService', () => {
  it('records stale pools without an indexer or Postgres dependency', async () => {
    const deps = dependencies([stalePool]);
    await new BackupKeeperService(deps.pools, deps.recorder, deps.alerts).run({ dryRun: false });
    expect(deps.pools.staleMemePools).toHaveBeenCalledWith(420);
    expect(deps.recorder.submitBatch).toHaveBeenCalledWith([stalePool]);
    expect(deps.alerts.send).toHaveBeenCalledWith(expect.stringContaining('Backup keeper recorded 1'));
  });

  it('does not submit when every observation is younger than 420 seconds', async () => {
    const deps = dependencies([]);
    await new BackupKeeperService(deps.pools, deps.recorder, deps.alerts).run({ dryRun: false });
    expect(deps.recorder.submitBatch).not.toHaveBeenCalled();
  });

  it('prints a backup dry run without sending a transaction or alert', async () => {
    const deps = dependencies([stalePool]);
    const result = await new BackupKeeperService(deps.pools, deps.recorder, deps.alerts).run({ dryRun: true });
    expect(result).toEqual(expect.objectContaining({ dryRun: true, poolCount: 1 }));
    expect(deps.recorder.submitBatch).not.toHaveBeenCalled();
    expect(deps.recorder.waitForReceipt).not.toHaveBeenCalled();
    expect(deps.alerts.send).not.toHaveBeenCalled();
  });

  it('alerts a failed run without leaking the paid RPC URL, and survives a failing alert', async () => {
    const rpcUrl = 'https://robinhood.g.alchemy.com/v2/SECRET_KEY';
    const alerts: AlertSink = { send: vi.fn() };
    await reportBackupFailure(new Error(`HTTP request failed. URL: ${rpcUrl} Status: 429`), alerts, rpcUrl);
    expect(alerts.send).toHaveBeenCalledWith('Backup keeper run failed: HTTP request failed. URL: <rpc> Status: 429');

    const failing: AlertSink = { send: vi.fn().mockRejectedValue(new Error('Telegram returned 502')) };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(reportBackupFailure(new Error('reverted'), failing, rpcUrl)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
