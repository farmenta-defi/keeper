import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcCostLedger } from '../src/rpc-cost.js';

describe('RpcCostLedger', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps one line per UTC day', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'keeper-')), 'rpc-cost.json');
    const ledger = new RpcCostLedger(path);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T23:59:59Z'));
    ledger.record(1_000);
    vi.setSystemTime(new Date('2026-09-29T00:00:01Z'));
    ledger.record();
    ledger.record();
    expect(readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([
      { date: '2026-09-28', requests: 1_000, units: 1_000 },
      { date: '2026-09-29', requests: 2, units: 2 },
    ]);
  });

  it('persists daily request units for reconciliation', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'keeper-')), 'rpc-cost.json');
    const ledger = new RpcCostLedger(path, 3);
    ledger.record(); ledger.record(2);
    const usage = JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as { requests: number; units: number };
    expect(usage).toMatchObject({ requests: 3, units: 9 });
  });
});
