import type { Address, MarketAddresses } from './types.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export interface LiquidatorConfig {
  rpcUrl: string;
  chainId: number;
  privateKey: `0x${string}`;
  indexerUrl: string;
  maxIndexerLagSeconds: number;
  rpcCostPath: string;
  routeApiUrl: string;
  markets: MarketAddresses[];
  treasury: Address;
  pollIntervalMs: number;
  maxCallBatch: number;
  minGasBalance: bigint;
  dryRun: boolean;
}

export function liquidatorConfig(argv = process.argv): LiquidatorConfig {
  const markets = JSON.parse(required('KEEPER_MARKETS_JSON')) as MarketAddresses[];
  if (!Array.isArray(markets) || markets.length === 0) throw new Error('KEEPER_MARKETS_JSON must contain at least one market');
  return {
    rpcUrl: required('KEEPER_RPC_URL'),
    chainId: positiveInteger('KEEPER_CHAIN_ID', 4663),
    privateKey: required('KEEPER_PRIVATE_KEY') as `0x${string}`,
    indexerUrl: required('KEEPER_INDEXER_URL').replace(/\/$/, ''),
    maxIndexerLagSeconds: positiveInteger('KEEPER_MAX_INDEXER_LAG_SECONDS', 60),
    rpcCostPath: process.env.KEEPER_RPC_COST_PATH ?? './rpc-cost.json',
    routeApiUrl: required('KEEPER_ROUTE_API_URL').replace(/\/$/, ''),
    markets,
    treasury: required('KEEPER_TREASURY') as Address,
    pollIntervalMs: positiveInteger('KEEPER_POLL_INTERVAL_MS', 2_000),
    maxCallBatch: positiveInteger('KEEPER_MAX_CALL_BATCH', 100),
    minGasBalance: BigInt(required('KEEPER_MIN_GAS_BALANCE_WEI')),
    dryRun: argv.includes('--dry-run'),
  };
}
