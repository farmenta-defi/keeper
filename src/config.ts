import type { Address, MarketAddresses, PoolKey } from './types.js';
import { getAddress, isAddress } from 'viem';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function address(name: string): Address {
  const value = required(name);
  if (!isAddress(value) || BigInt(value) === 0n) throw new Error(`${name} must be a non-zero address`);
  return getAddress(value) as Address;
}

function routePools(): PoolKey[] {
  const raw = process.env.KEEPER_ROUTE_POOLS_JSON;
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('KEEPER_ROUTE_POOLS_JSON must contain an array');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`KEEPER_ROUTE_POOLS_JSON[${index}] must be an object`);
    const row = entry as Record<string, unknown>;
    const requiredAddresses = ['id', 'currency0', 'currency1', 'hooks'] as const;
    if (requiredAddresses.some((field) => typeof row[field] !== 'string' || !isAddress(row[field] as string) && field !== 'id')) throw new Error(`KEEPER_ROUTE_POOLS_JSON[${index}] contains an invalid address`);
    if (typeof row.id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(row.id) || typeof row.fee !== 'number' || typeof row.tickSpacing !== 'number') throw new Error(`KEEPER_ROUTE_POOLS_JSON[${index}] is incomplete`);
    return { id: row.id as `0x${string}`, currency0: getAddress(row.currency0 as string) as Address, currency1: getAddress(row.currency1 as string) as Address, fee: row.fee, tickSpacing: row.tickSpacing, hooks: getAddress(row.hooks as string) as Address, observationAgeSeconds: null };
  });
}

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

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export interface LiquidatorConfig {
  rpcUrl: string; chainId: number; privateKey: `0x${string}`; indexerUrl: string;
  maxIndexerLagSeconds: number; rpcCostPath: string; v4Quoter: Address; universalRouter: Address; usdg: Address;
  markets: MarketAddresses[]; treasury: Address; pollIntervalMs: number; maxCallBatch: number;
  minGasBalance: bigint; dryRun: boolean; multicall3: Address; recorder: Address;
  ethUsd: number;
}

export function liquidatorConfig(argv = process.argv): LiquidatorConfig {
  const rawMarkets: unknown = JSON.parse(required('KEEPER_MARKETS_JSON'));
  if (!Array.isArray(rawMarkets) || rawMarkets.length === 0) throw new Error('KEEPER_MARKETS_JSON must contain at least one market');
  const markets = rawMarkets.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`KEEPER_MARKETS_JSON[${index}] must be an object`);
    const entry = value as Record<string, unknown>;
    const fields = ['market', 'lens', 'helper', 'policy'] as const;
    if (fields.some((field) => typeof entry[field] !== 'string' || !isAddress(entry[field] as string) || BigInt(entry[field] as string) === 0n)) throw new Error(`KEEPER_MARKETS_JSON[${index}] contains an invalid address`);
    return { ...Object.fromEntries(fields.map((field) => [field, getAddress(entry[field] as string)])), routePools: routePools() } as unknown as MarketAddresses;
  });
  const ethUsd = Number(process.env.KEEPER_ETH_USD ?? 2400);
  if (!Number.isFinite(ethUsd) || ethUsd <= 0) throw new Error('KEEPER_ETH_USD must be positive');
  return {
    rpcUrl: required('KEEPER_RPC_URL'), chainId: positiveInteger('KEEPER_CHAIN_ID', 4663),
    privateKey: required('KEEPER_LIQUIDATOR_PRIVATE_KEY') as `0x${string}`,
    indexerUrl: required('KEEPER_INDEXER_URL').replace(/\/$/, ''),
    maxIndexerLagSeconds: positiveInteger('KEEPER_MAX_INDEXER_LAG_SECONDS', 60),
    rpcCostPath: process.env.KEEPER_RPC_COST_PATH ?? './rpc-cost.json',
    v4Quoter: address('KEEPER_V4_QUOTER'), universalRouter: address('KEEPER_UNIVERSAL_ROUTER'), usdg: address('KEEPER_USDG'), recorder: address('KEEPER_TWAP_RECORDER'),
    markets, treasury: address('KEEPER_TREASURY'),
    pollIntervalMs: positiveInteger('KEEPER_POLL_INTERVAL_MS', 2_000), maxCallBatch: positiveInteger('KEEPER_MAX_CALL_BATCH', 100),
    minGasBalance: BigInt(required('KEEPER_MIN_GAS_BALANCE_WEI')), dryRun: argv.includes('--dry-run'), ethUsd, multicall3: address('KEEPER_MULTICALL3'),
  };
}
