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
