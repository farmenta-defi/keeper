import { liquidatorConfig } from './config.js';
import { LiquidationIndexerSource } from './indexer-source.js';
import { Liquidator } from './liquidator.js';
import type { AlertSink } from './types.js';
import { ViemChain } from './viem-chain.js';
import { RpcCostLedger } from './rpc-cost.js';
import { TelegramAlertSink } from './telegram.js';

const config = liquidatorConfig();
const alerts: AlertSink = new TelegramAlertSink(process.env.TELEGRAM_BOT_TOKEN ?? (() => { throw new Error('TELEGRAM_BOT_TOKEN is required'); })(), process.env.TELEGRAM_CHAT_ID ?? (() => { throw new Error('TELEGRAM_CHAT_ID is required'); })());
const costs = new RpcCostLedger(config.rpcCostPath);
const bot = new Liquidator(new LiquidationIndexerSource(config.indexerUrl, config.markets.map((market) => market.market), config.maxIndexerLagSeconds, fetch, undefined, costs), new ViemChain(config.rpcUrl, config.privateKey, config.chainId, config.v4Quoter, config.universalRouter, config.usdg, costs, config.multicall3, config.recorder), alerts, config);

const runCycle = async (): Promise<void> => {
  await bot.cycle();
};
await runCycle();
if (!config.dryRun) {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    await runCycle();
  }
}
