import { liquidatorConfig } from './config.js';
import { LiquidationIndexerSource } from './indexer-source.js';
import { Liquidator } from './liquidator.js';
import type { AlertSink } from './types.js';
import { ViemChain } from './viem-chain.js';
import { RpcCostLedger } from './rpc-cost.js';

const config = liquidatorConfig();
const alerts: AlertSink = {
  async send(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return console.error(message);
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: message }) });
  },
};
const costs = new RpcCostLedger(config.rpcCostPath);
const bot = new Liquidator(new LiquidationIndexerSource(config.indexerUrl, config.markets.map((market) => market.market), config.maxIndexerLagSeconds, fetch, undefined, costs), new ViemChain(config.rpcUrl, config.privateKey, config.routeApiUrl, config.chainId, costs, config.routeApiHmacSecret), alerts, config);

const runCycle = async (): Promise<void> => {
  try { await bot.cycle(); } catch (error) { console.error('liquidator cycle failed', error instanceof Error ? error.name : 'unknown error'); }
};
await runCycle();
if (!config.dryRun) {
  const poll = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    await runCycle();
    await poll();
  };
  await poll();
}
