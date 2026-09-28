import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcCostLedger } from '../src/rpc-cost.js';

describe('RpcCostLedger', () => {
  it('persists daily request units for reconciliation', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'keeper-')), 'rpc-cost.json');
    const ledger = new RpcCostLedger(path, 3);
    ledger.record(); ledger.record(2);
    const usage = JSON.parse(readFileSync(path, 'utf8')) as { requests: number; units: number };
    expect(usage).toMatchObject({ requests: 3, units: 9 });
  });
});
