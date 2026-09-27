import type { AlertSink, Candidate, CandidateSource, Chain, MarketAddresses, PositionState, TransactionPlan } from './types.js';

const WAD = 10n ** 18n;
const BPS = 10_000n;
const RAMP_GRACE_SECONDS = 60;

export interface LiquidatorOptions {
  markets: MarketAddresses[];
  treasury: `0x${string}`;
  maxCallBatch: number;
  minGasBalance: bigint;
  dryRun: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Decides from MarketLens' liquidation views and the helper's exact eth_call.
 * It deliberately contains no TypeScript health-factor arithmetic.
 */
export class Liquidator {
  private readonly firstUnhealthyAt = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly lastAlertAt = new Map<string, number>();
  private running = false;

  constructor(
    private readonly source: CandidateSource,
    private readonly chain: Chain,
    private readonly alerts: AlertSink,
    private readonly options: LiquidatorOptions,
  ) {}

  async cycle(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runCycle();
    } finally {
      this.running = false;
    }
  }

  private async runCycle(): Promise<void> {
    if (await this.chain.gasBalance() < this.options.minGasBalance) {
      await this.alert('gas-balance', 'keeper liquidator gas balance is below its configured minimum');
      return;
    }

    const candidates = await this.source.candidates();
    for (const market of this.options.markets) {
      const marketCandidates = candidates.filter((candidate) => candidate.market.toLowerCase() === market.market.toLowerCase());
      for (const batch of chunks(marketCandidates, this.options.maxCallBatch)) await this.processBatch(market, batch);
    }
  }

  private async processBatch(market: MarketAddresses, candidates: Candidate[]): Promise<void> {
    const states = await this.chain.positions(market, candidates);
    for (const candidate of candidates) {
      const state = states.get(candidate.tokenId);
      if (!state || state.debt === 0n || state.healthFactor >= WAD) {
        this.firstUnhealthyAt.delete(key(candidate));
        continue;
      }
      await this.processUnhealthy(market, candidate, state);
    }
  }

  private async processUnhealthy(market: MarketAddresses, candidate: Candidate, state: PositionState): Promise<void> {
    const now = (this.options.now ?? unixNow)();
    const candidateKey = key(candidate);
    const firstSeenAt = this.firstUnhealthyAt.get(candidateKey) ?? now;
    this.firstUnhealthyAt.set(candidateKey, firstSeenAt);
    const rampActive = state.rampEndsAt > now;
    const persistedFor = now - firstSeenAt;
    const alertAfter = rampActive ? 180 : 120;
    if (persistedFor > alertAfter) await this.alert(`unhealthy:${candidateKey}`, `liquidation candidate ${candidate.tokenId} remains unhealthy for ${persistedFor}s`);

    if (rampActive && persistedFor < RAMP_GRACE_SECONDS) return;

    const closeFactorRepay = state.debt * BigInt(state.closeFactorBps) / BPS;
    if (closeFactorRepay === 0n) return;
    try {
      const route = await this.chain.quote(market, candidate, closeFactorRepay);
      const repayAmount = route.requiredRepayAmount ?? closeFactorRepay;
      if (repayAmount > state.debt) throw new Error('route requested more than the current debt');
      const gas = await this.chain.simulate(market, candidate, repayAmount, route);
      const gasPrice = await this.chain.gasPrice();
      const plan: TransactionPlan = { candidate, repayAmount, route, gas, gasPrice };
      if (plan.route.expectedProfit <= plan.gas * plan.gasPrice) return;
      if (this.options.dryRun) {
        (this.options.log ?? console.log)(JSON.stringify(serializePlan(plan)));
        return;
      }
      const transactionHash = await this.chain.submit(market, candidate, repayAmount, route);
      await this.chain.waitForReceipt(transactionHash);
      await this.chain.sweep(market, this.options.treasury);
      this.firstUnhealthyAt.delete(candidateKey);
      this.failures.delete(candidateKey);
    } catch (error) {
      // A race loser sees the current helper call revert during eth_call and never broadcasts.
      const failures = (this.failures.get(candidateKey) ?? 0) + 1;
      this.failures.set(candidateKey, failures);
      if (failures >= 2) await this.alert(`failure:${candidateKey}`, `liquidation ${candidate.tokenId} failed ${failures} times: ${safeReason(error)}`);
    }
  }

  private async alert(subject: string, text: string): Promise<void> {
    const now = (this.options.now ?? unixNow)();
    if ((this.lastAlertAt.get(subject) ?? 0) + 600 > now) return;
    this.lastAlertAt.set(subject, now);
    try { await this.alerts.send(text); } catch { /* Alert delivery must not stop liquidation monitoring. */ }
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function key(candidate: Candidate): string { return `${candidate.market}:${candidate.tokenId}`; }
function unixNow(): number { return Math.floor(Date.now() / 1_000); }
function safeReason(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  if (/FeePurchaseUnderfunded/.test(reason)) return 'fee purchase was underfunded';
  if (/PositionIsHealthy/.test(reason)) return 'position was already healthy';
  return 'simulation or execution failed';
}

function serializePlan(plan: TransactionPlan) {
  return {
    tokenId: plan.candidate.tokenId.toString(),
    market: plan.candidate.market,
    repayAmount: plan.repayAmount.toString(),
    expectedProfit: plan.route.expectedProfit.toString(),
    gas: plan.gas.toString(),
    gasPrice: plan.gasPrice.toString(),
  };
}
