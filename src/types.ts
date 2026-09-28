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

export interface Candidate { market: Address; tokenId: bigint; poolId: PoolId; tier: number; poolKey?: PoolKey }
export interface MarketAddresses { market: Address; lens: Address; helper: Address; policy: Address }
export interface PositionState { healthFactor: bigint; debt: bigint; closeFactorBps: number; rampStartsAt: number; rampEndsAt: number; stale?: boolean }
export interface SwapRoute { calldata: `0x${string}`; expectedProfit: bigint; requiredRepayAmount?: bigint }
export interface TransactionPlan { candidate: Candidate; repayAmount: bigint; route: SwapRoute; gas: bigint; gasPrice: bigint }
export interface CandidateSource { candidates(): Promise<Candidate[]> }
export interface Chain {
  positions(market: MarketAddresses, candidates: Candidate[]): Promise<Map<bigint, PositionState>>;
  quote(market: MarketAddresses, candidate: Candidate, repayAmount: bigint): Promise<SwapRoute>;
  simulate(market: MarketAddresses, candidate: Candidate, repayAmount: bigint, route: SwapRoute): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  submit(market: MarketAddresses, candidate: Candidate, repayAmount: bigint, route: SwapRoute, gas: bigint, maxFeePerGas: bigint): Promise<`0x${string}`>;
  waitForReceipt(hash: `0x${string}`): Promise<void>;
  sweep(market: MarketAddresses, treasury: Address): Promise<`0x${string}` | undefined>;
  gasBalance(): Promise<bigint>;
  recordPool(poolKey: PoolKey): Promise<`0x${string}`>;
}
