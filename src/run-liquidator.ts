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
const bot = new Liquidator(new LiquidationIndexerSource(config.indexerUrl, config.markets.map((market) => market.market), config.maxIndexerLagSeconds), new ViemChain({ rpcUrl: config.rpcUrl, privateKey: config.privateKey, chainId: config.chainId, quoter: config.v4Quoter, usdg: config.usdg, multicall3: config.multicall3, recorder: config.recorder, costs, slippageBps: config.slippageBps }), alerts, config);

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
