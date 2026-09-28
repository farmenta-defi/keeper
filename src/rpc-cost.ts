import { readFileSync, writeFileSync } from 'node:fs';

interface DailyUsage { date: string; requests: number; units: number }

/** Persists a provider-neutral request/unit ledger for paid-RPC cost reconciliation. */
export class RpcCostLedger {
  constructor(private readonly path: string, private readonly unitsPerRequest = 1) {}

  record(requests = 1): void {
    const date = new Date().toISOString().slice(0, 10);
    const entries = (() => {
      try { return readFileSync(this.path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as DailyUsage); }
      catch { return []; }
    })();
    const usage = entries.find((entry) => entry.date === date) ?? { date, requests: 0, units: 0 };
    usage.requests += requests;
    usage.units += requests * this.unitsPerRequest;
    const index = entries.findIndex((entry) => entry.date === date);
    if (index === -1) entries.push(usage); else entries[index] = usage;
    writeFileSync(this.path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, { mode: 0o600 });
  }
}
