import { ChainLogBackupPoolSource } from './backup-pool-source.js';
import { BackupKeeperService } from './backup-service.js';
import { backupConfig } from './config.js';
import { ViemRecorder } from './recorder.js';
import { TelegramAlertSink } from './telegram.js';

const config = backupConfig();
const result = await new BackupKeeperService(
  new ChainLogBackupPoolSource(config.rpcUrl, config.collateralPolicy, config.poolManager, config.recorder, config.logStartBlock),
  new ViemRecorder(config.rpcUrl, config.privateKey, config.recorder, config.multicall3), new TelegramAlertSink(config.telegramToken, config.telegramChatId),
).run({ dryRun: process.argv.includes('--dry-run') });
console.log(JSON.stringify(result));
