import { liquidatorConfig } from './config.js';
import { IndexerSource } from './indexer-source.js';
import { Liquidator } from './liquidator.js';
import type { AlertSink } from './types.js';
import { ViemChain } from './viem-chain.js';

const config = liquidatorConfig();
const alerts: AlertSink = {
  async send(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return console.error(message);
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: message }) });
  },
};
const bot = new Liquidator(new IndexerSource(config.indexerUrl, config.markets.map((market) => market.market)), new ViemChain(config.rpcUrl, config.privateKey, config.routeApiUrl, config.chainId), alerts, config);

await bot.cycle();
if (!config.dryRun) {
  const poll = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    try { await bot.cycle(); } catch (error) { console.error('liquidator cycle failed', error instanceof Error ? error.name : 'unknown error'); }
    await poll();
  };
  await poll();
}
