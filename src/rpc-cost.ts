import { readFileSync, writeFileSync } from 'node:fs';

interface DailyUsage { date: string; requests: number; units: number }

/** Persists a provider-neutral request/unit ledger for paid-RPC cost reconciliation. */
export class RpcCostLedger {
  constructor(private readonly path: string, private readonly unitsPerRequest = 1) {}

  record(requests = 1): void {
    const date = new Date().toISOString().slice(0, 10);
    let usage: DailyUsage = { date, requests: 0, units: 0 };
    try { usage = JSON.parse(readFileSync(this.path, 'utf8')) as DailyUsage; } catch { /* first write */ }
    if (usage.date !== date) usage = { date, requests: 0, units: 0 };
    usage.requests += requests;
    usage.units += requests * this.unitsPerRequest;
    writeFileSync(this.path, `${JSON.stringify(usage)}\n`, { mode: 0o600 });
  }
}
