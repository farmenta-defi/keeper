import { primaryConfig } from './config.js';
import { PostgresPrimaryStore } from './database.js';
import { PonderIndexerSource } from './indexer-source.js';
import { PrimaryKeeperService } from './primary-service.js';
import { ViemRecorder } from './recorder.js';
import { TelegramAlertSink } from './telegram.js';

const config = primaryConfig();
const result = await new PrimaryKeeperService(
  new PonderIndexerSource(config.indexerUrl, config.maxIndexerLagSeconds), new ViemRecorder(config.rpcUrl, config.privateKey, config.recorder, config.multicall3),
  new PostgresPrimaryStore(config.databaseUrl), new TelegramAlertSink(config.telegramToken, config.telegramChatId), config.ethUsd,
).run({ dryRun: process.argv.includes('--dry-run') });
console.log(JSON.stringify(result));
