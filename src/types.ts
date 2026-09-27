export type Address = `0x${string}`;
export type PoolId = `0x${string}`;

export interface PoolKey {
  id: PoolId;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  observationAgeSeconds: number | null;
}

export interface KeeperCandidate { market: Address; tokenId: bigint; poolId: PoolId }
export interface Receipt { hash: string; gasUsed: bigint; gasPrice: bigint }

export interface IndexerSource {
  assertFresh(): Promise<void>;
  candidates(): Promise<KeeperCandidate[]>;
  pools(): Promise<PoolKey[]>;
}

export interface Recorder {
  debts(market: Address, tokenIds: bigint[]): Promise<bigint[]>;
  observationCounts(poolIds: PoolId[]): Promise<number[]>;
  submitBatch(pools: PoolKey[]): Promise<string>;
  waitForReceipt(hash: string): Promise<Receipt>;
}

export interface PrimaryStore {
  saveRun(run: { ranAt: number; poolCount: number; gasUsed: bigint; gasCostUsd: number; budgetUsd: number; transactionHash: string }): Promise<void>;
  dailyTotals(): Promise<{ costUsd: number; budgetUsd: number }>;
  claimAlert(key: string, at: number, reminderSeconds: number): Promise<boolean>;
  releaseAlert(key: string): Promise<void>;
  heartbeat(at: number): Promise<void>;
}

export interface AlertSink { send(message: string): Promise<void> }
export interface BackupPoolSource { staleMemePools(minimumAgeSeconds: number): Promise<PoolKey[]> }
