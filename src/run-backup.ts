import { ChainLogBackupPoolSource } from './backup-pool-source.js';
import { BackupKeeperService, reportBackupFailure } from './backup-service.js';
import { backupConfig } from './config.js';
import { ViemRecorder } from './recorder.js';
import { TelegramAlertSink } from './telegram.js';

const config = backupConfig();
const alerts = new TelegramAlertSink(config.telegramToken, config.telegramChatId);
const dryRun = process.argv.includes('--dry-run');

try {
  const result = await new BackupKeeperService(
    new ChainLogBackupPoolSource(config.rpcUrl, config.collateralPolicy, config.poolManager, config.recorder, config.logStartBlock, config.poolManagerStartBlock),
    new ViemRecorder(config.rpcUrl, config.privateKey, config.recorder, config.multicall3),
    alerts,
  ).run({ dryRun });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error('Backup keeper run failed', error);
  if (!dryRun) await reportBackupFailure(error, alerts, config.rpcUrl);
  process.exitCode = 1;
}
