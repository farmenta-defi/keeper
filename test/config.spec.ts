import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liquidatorConfig } from '../src/config.js';

const market = { market: '0x00000000000000000000000000000000000000aa', lens: '0x00000000000000000000000000000000000000ab', helper: '0x00000000000000000000000000000000000000ac', policy: '0x00000000000000000000000000000000000000ad' };
const pool = { id: '0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32', currency0: '0x0000000000000000000000000000000000000000', currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', fee: 460, tickSpacing: 9, hooks: '0x0000000000000000000000000000000000000000' };
const environment: Record<string, string> = {
  KEEPER_MARKETS_JSON: JSON.stringify([market]), KEEPER_RPC_URL: 'http://127.0.0.1:8545', KEEPER_LIQUIDATOR_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  KEEPER_INDEXER_URL: 'http://127.0.0.1:42069/', KEEPER_V4_QUOTER: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94', KEEPER_USDG: pool.currency1,
  KEEPER_TWAP_RECORDER: '0x00000000000000000000000000000000000000ee', KEEPER_MULTICALL3: '0xca11bde05977b3631167028862be2a173976ca11',
  KEEPER_MIN_GAS_BALANCE_WEI: '10000000000000000', KEEPER_TREASURY: '0x00000000000000000000000000000000000000f1',
};
const read = () => liquidatorConfig(['bun', 'src/run-liquidator.ts']);

describe('liquidatorConfig', () => {
  beforeEach(() => { for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value); });
  afterEach(() => vi.unstubAllEnvs());

  it('reads the defaults, and the dry run from the command line', () => {
    expect(read()).toMatchObject({ chainId: 4663, pollIntervalMs: 2_000, maxCallBatch: 100, slippageBps: 50, dryRun: false, indexerUrl: 'http://127.0.0.1:42069', minGasBalance: 10n ** 16n });
    expect(read().markets[0]!.routePools).toEqual([]);
    expect(liquidatorConfig(['bun', 'src/run-liquidator.ts', '--dry-run']).dryRun).toBe(true);
  });

  it('refuses a treasury that is not a non-zero address', () => {
    vi.stubEnv('KEEPER_TREASURY', '0x1234');
    expect(read).toThrow('KEEPER_TREASURY must be a non-zero address');
    vi.stubEnv('KEEPER_TREASURY', '0x0000000000000000000000000000000000000000');
    expect(read).toThrow('KEEPER_TREASURY must be a non-zero address');
  });

  it('refuses a market with a missing or zero address', () => {
    vi.stubEnv('KEEPER_MARKETS_JSON', JSON.stringify([{ ...market, helper: undefined }]));
    expect(read).toThrow('KEEPER_MARKETS_JSON[0] contains an invalid address');
    vi.stubEnv('KEEPER_MARKETS_JSON', JSON.stringify([{ ...market, lens: '0x0000000000000000000000000000000000000000' }]));
    expect(read).toThrow('KEEPER_MARKETS_JSON[0] contains an invalid address');
  });

  it('reads route pools, native ETH included, and refuses an incomplete one', () => {
    vi.stubEnv('KEEPER_ROUTE_POOLS_JSON', JSON.stringify([pool]));
    expect(read().markets[0]!.routePools).toEqual([{ ...pool, currency1: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', observationAgeSeconds: null }]);
    vi.stubEnv('KEEPER_ROUTE_POOLS_JSON', JSON.stringify([{ ...pool, fee: undefined }]));
    expect(read).toThrow('KEEPER_ROUTE_POOLS_JSON[0] is incomplete');
    vi.stubEnv('KEEPER_ROUTE_POOLS_JSON', JSON.stringify([{ ...pool, hooks: '0x12' }]));
    expect(read).toThrow('KEEPER_ROUTE_POOLS_JSON[0] contains an invalid address');
  });

  it('refuses a slippage floor that is not inside (0, 10000)', () => {
    vi.stubEnv('KEEPER_SLIPPAGE_BPS', '10000');
    expect(read).toThrow('KEEPER_SLIPPAGE_BPS must be below 10000');
    vi.stubEnv('KEEPER_SLIPPAGE_BPS', '0');
    expect(read).toThrow('KEEPER_SLIPPAGE_BPS must be a positive integer');
  });
});
