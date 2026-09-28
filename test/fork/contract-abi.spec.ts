import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { renderContractAbi } from '../../scripts/contract-abi.js';

const contracts = process.env.SMART_CONTRACT_DIR;
if (!contracts) throw new Error('SMART_CONTRACT_DIR is required for bun run test:fork');

describe('src/contract-abi.ts', () => {
  it('is what the pinned contracts compile to', async () => {
    const { commit } = JSON.parse(await readFile('contracts/source.json', 'utf8')) as { commit: string };
    // Out of date after a re-pin or an edit by hand: run `bun run abi:generate`.
    expect(await readFile('src/contract-abi.ts', 'utf8')).toBe(await renderContractAbi(contracts, commit));
  });
});
