import type { AlertSink, BackupPoolSource, Recorder } from './types.js';

export class BackupKeeperService {
  constructor(
    private readonly pools: BackupPoolSource,
    private readonly recorder: Recorder,
    private readonly alerts: AlertSink,
  ) {}

  async run({ dryRun }: { dryRun: boolean }) {
    const stalePools = await this.pools.staleMemePools(420);
    if (dryRun) return { dryRun: true, poolCount: stalePools.length, pools: stalePools };
    if (stalePools.length === 0) return { dryRun: false, poolCount: 0 };
    const transactionHash = await this.recorder.submitBatch(stalePools);
    const receipt = await this.recorder.waitForReceipt(transactionHash);
    const gasCostEth = Number(receipt.gasUsed * receipt.gasPrice) / 1e18;
    await this.alerts.send(`Backup keeper recorded ${stalePools.length} meme pool(s) because observations exceeded 420s; tx ${receipt.hash}, gas ${gasCostEth.toFixed(6)} ETH.`);
    return { dryRun: false, poolCount: stalePools.length, transactionHash: receipt.hash };
  }
}

/**
 * Alerts that a backup run failed. The backup is the last safeguard when the VPS, and the FAR-36
 * watchdog on it, are down; a failed GitHub Actions run alone is seen by no one (spec §13 v1.42).
 * viem errors embed the request URL, and the paid RPC URL carries its API key, so it is redacted.
 */
export async function reportBackupFailure(error: unknown, alerts: AlertSink, rpcUrl: string) {
  const text = error instanceof Error
    ? ('shortMessage' in error && typeof error.shortMessage === 'string' ? error.shortMessage : error.message)
    : String(error);
  try {
    await alerts.send(`Backup keeper run failed: ${text.split(rpcUrl).join('<rpc>').slice(0, 500)}`);
  } catch (alertError) {
    console.error('Backup keeper failure alert failed', alertError);
  }
}
