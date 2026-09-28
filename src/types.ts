export type Address = `0x${string}`;

export interface Candidate { market: Address; tokenId: bigint; poolId: `0x${string}`; tier: number }

export interface MarketAddresses { market: Address; lens: Address; helper: Address; policy: Address }

export interface PositionState {
  healthFactor: bigint;
  debt: bigint;
  closeFactorBps: number;
  rampStartsAt: number;
  rampEndsAt: number;
}

export interface SwapRoute {
  calldata: `0x${string}`;
  expectedProfit: bigint;
  /** Includes any non-USDG retained-fee purchase exposed by a preliminary helper simulation. */
  requiredRepayAmount?: bigint;
}

export interface TransactionPlan {
  candidate: Candidate;
  repayAmount: bigint;
  route: SwapRoute;
  gas: bigint;
  gasPrice: bigint;
}

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
}

export interface AlertSink { send(message: string): Promise<void> }
