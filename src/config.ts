import type { Address } from './types.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function address(name: string) { return required(name) as Address; }

export function primaryConfig() {
  const databaseUrl = required('DATABASE_URL');
  if (new URL(databaseUrl).pathname !== '/farmenta') throw new Error('DATABASE_URL must target the farmenta database');
  const maxIndexerLagSeconds = Number(required('KEEPER_MAX_INDEXER_LAG_SECONDS'));
  const ethUsd = Number(required('KEEPER_ETH_USD'));
  if (!Number.isFinite(maxIndexerLagSeconds) || !Number.isFinite(ethUsd)) throw new Error('Keeper numeric configuration is invalid');
  return {
    databaseUrl, rpcUrl: required('KEEPER_RPC_URL'), indexerUrl: required('KEEPER_INDEXER_URL'), privateKey: required('KEEPER_PRIVATE_KEY') as `0x${string}`,
    recorder: address('KEEPER_TWAP_RECORDER'), multicall3: address('KEEPER_MULTICALL3'), maxIndexerLagSeconds, ethUsd,
    telegramToken: required('TELEGRAM_BOT_TOKEN'), telegramChatId: required('TELEGRAM_CHAT_ID'),
  };
}

export function backupConfig() {
  return {
    rpcUrl: required('KEEPER_RPC_URL'), privateKey: required('KEEPER_BACKUP_PRIVATE_KEY') as `0x${string}`,
    recorder: address('KEEPER_TWAP_RECORDER'), multicall3: address('KEEPER_MULTICALL3'), collateralPolicy: address('KEEPER_COLLATERAL_POLICY'),
    poolManager: address('KEEPER_POOL_MANAGER'), telegramToken: required('TELEGRAM_BOT_TOKEN'), telegramChatId: required('TELEGRAM_CHAT_ID'),
    logStartBlock: BigInt(required('KEEPER_LOG_START_BLOCK')),
    poolManagerStartBlock: BigInt(required('KEEPER_POOL_MANAGER_START_BLOCK')),
  };
}
