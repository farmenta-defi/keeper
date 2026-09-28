import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, type Abi, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Candidate, MarketAddresses, PoolKey } from '../../../src/types.js';

const execute = promisify(execFile);

// Robinhood Chain at the pinned block (spec §18).
export const PINNED_BLOCK = 54_200_000;
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;
export const V4_QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94' as Address;
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const POSITION_MANAGER = '0x58daec3116aae6D93017bAAea7749052E8a04fA7' as Address;
const MORPHO_BLUE = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010' as Address;
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
/** `Fixtures.POS_ETH_USDG_DYN_IN_RANGE`: in range, in the dynamic-fee ETH/USDG pool, of which it is all the active liquidity. */
const POSITION = 913_889n;
/** `Fixtures.liveRecorderPoolKeys()[1]`: the plain ETH/USDG pool, where a full seizure can still be sold. */
export const PLAIN_POOL: PoolKey = { id: '0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32', currency0: NATIVE, currency1: USDG, fee: 460, tickSpacing: 9, hooks: NATIVE, observationAgeSeconds: null };
/** The fixture pool's own spot price at the pinned block, 8 decimals as Chainlink reports ETH/USD. */
export const ETH_AT_POOL_SPOT = 252_013_244_402n;

// Anvil's funded accounts.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
export const BOT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const LENDER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex;

const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)']);
const positionManagerAbi = parseAbi([
  'function ownerOf(uint256) view returns (address)', 'function approve(address,uint256)',
  'function getPoolAndPositionInfo(uint256) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks), uint256)',
]);

interface Artifact { abi: Abi; bytecode: { object: Hex } }

export interface FarmentaFork {
  url: string;
  bot: Address;
  market: MarketAddresses;
  recorder: Address;
  candidate: Candidate;
  /** Moves the ETH/USD feed, keeping it fresh. */
  setEthPrice(price: bigint): Promise<void>;
  /** Lowers ETH from the pool's spot, 1% at a time, until the loan's liquidation HF is inside [low, high). */
  dropEthUntilHealthFactor(low: bigint, high: bigint): Promise<bigint>;
  healthFactor(): Promise<bigint>;
  debt(): Promise<bigint>;
  usdgOf(account: Address): Promise<bigint>;
  nonceOf(account: Address): Promise<number>;
  holderOfPosition(): Promise<Address | undefined>;
  /** Back to the open, healthy loan. */
  reset(): Promise<void>;
  stop(): void;
}

/**
 * An Anvil fork of the pinned block with Farmenta deployed by the contract repository's own
 * `script/Deploy.s.sol`, and one Blue-chip loan borrowed to its limit. Uniswap, Morpho and USDG
 * are the chain's. The two Chainlink feeds are `MockAggregatorV3`, handed to the deploy script the
 * way a deployment hands it the real ones: a price is what these tests move.
 */
export async function startFarmentaFork(forkUrl: string, contracts: string, port: number): Promise<FarmentaFork> {
  const url = `http://127.0.0.1:${port}`;
  const chain: Chain = { id: 4663, name: 'Robinhood Chain fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } };
  const anvil: ChildProcess = spawn('anvil', ['--fork-url', forkUrl, '--fork-block-number', String(PINNED_BLOCK), '--port', String(port)], { stdio: ['ignore', 'ignore', 'inherit'] });
  const transport = http(url, { timeout: 60_000 });
  const client = createPublicClient({ chain, transport });
  const test = createTestClient({ chain, transport, mode: 'anvil' });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await client.getBlockNumber(); break; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
    if (attempt === 59) throw new Error('Anvil did not start');
  }

  const source = JSON.parse(await readFile('contracts/source.json', 'utf8')) as { commit: string };
  const { stdout: head } = await execute('git', ['rev-parse', 'HEAD'], { cwd: contracts });
  if (head.trim() !== source.commit) throw new Error(`SMART_CONTRACT_DIR is at ${head.trim()}, contracts/source.json pins ${source.commit}`);
  await execute('forge', ['build'], { cwd: contracts });
  const artifact = async (name: string) => JSON.parse(await readFile(join(contracts, 'out', `${name}.sol`, `${name}.json`), 'utf8')) as Artifact;

  const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain, transport });
  const send = async (hash: Hex) => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`fixture transaction ${hash} reverted`);
    return receipt;
  };
  /** Sends as any address, the way `vm.prank` does in the contract repository's fork tests. */
  const sendAs = async (account: Address, request: { address: Address; abi: Abi; functionName: string; args: unknown[] }) => {
    await test.impersonateAccount({ address: account });
    await test.setBalance({ address: account, value: 10n ** 18n });
    const wallet = createWalletClient({ account, chain, transport });
    await send(await wallet.writeContract(request as never));
    await test.stopImpersonatingAccount({ address: account });
  };

  const feed = await artifact('MockAggregatorV3');
  const deployFeed = async () => (await send(await deployer.deployContract({ abi: feed.abi, bytecode: feed.bytecode.object, args: [8] }))).contractAddress!;
  const ethFeed = await deployFeed();
  const usdgFeed = await deployFeed();
  const setAnswer = async (address: Address, answer: bigint) => {
    const { timestamp } = await client.getBlock({ blockTag: 'latest' });
    await send(await deployer.writeContract({ address, abi: feed.abi, functionName: 'setAnswer', args: [answer, timestamp] }));
  };
  await setAnswer(ethFeed, ETH_AT_POOL_SPOT);
  await setAnswer(usdgFeed, 100_000_000n);

  // The broadcast log goes to a temporary directory: the contract repository tracks broadcast/.
  const { stdout: deployment } = await execute('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', url, '--private-key', DEPLOYER_KEY, '--broadcast', '--legacy'], {
    cwd: contracts, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DEPLOY_TIMELOCK: 'false', CHAINLINK_ETH_USD: ethFeed, CHAINLINK_USDG_USD: usdgFeed, FOUNDRY_BROADCAST: await mkdtemp(join(tmpdir(), 'keeper-fork-')) },
  });
  const deployed = (label: string): Address => {
    const match = new RegExp(`^\\s*${label.replace(/[()]/g, '\\$&')} (0x[0-9a-fA-F]{40})$`, 'm').exec(deployment);
    if (!match) throw new Error(`the deploy script did not print ${label}`);
    return match[1] as Address;
  };
  const market: MarketAddresses = {
    market: deployed('FarmentaMarket Blue-chip (proxy)'), lens: deployed('MarketLens Blue-chip'),
    helper: deployed('LiquidatorHelper Blue-chip'), policy: deployed('CollateralPolicy'),
  };
  const recorder = deployed('TwapRecorder');
  const [policyAbi, marketAbi, lensAbi] = (await Promise.all(['CollateralPolicy', 'FarmentaMarket', 'MarketLens'].map(artifact))).map(({ abi }) => abi);

  // The loan of the contract repository's LiquidatorHelper fork test: the fixture position, its
  // pool listed on the Blue-chip preset, 300 USDG lent, borrowed to the limit.
  const [key] = await client.readContract({ address: POSITION_MANAGER, abi: positionManagerAbi, functionName: 'getPoolAndPositionInfo', args: [POSITION] });
  await send(await deployer.writeContract({
    address: market.policy, abi: policyAbi!, functionName: 'list',
    args: [key, { maxLtvBps: 6_500, ltBps: 7_500, liquidatorBonusBps: 500, removeHaircutBps: 0, debtCapUsdg: 500_000_000_000n, minPositionUsd: 50n * 10n ** 18n }],
  }));
  const borrower = await client.readContract({ address: POSITION_MANAGER, abi: positionManagerAbi, functionName: 'ownerOf', args: [POSITION] });
  await sendAs(borrower, { address: POSITION_MANAGER, abi: positionManagerAbi as Abi, functionName: 'approve', args: [market.market, POSITION] });
  await sendAs(borrower, { address: market.market, abi: marketAbi!, functionName: 'depositCollateral', args: [POSITION] });
  const lender = createWalletClient({ account: privateKeyToAccount(LENDER_KEY), chain, transport });
  await sendAs(MORPHO_BLUE, { address: USDG, abi: erc20Abi as Abi, functionName: 'transfer', args: [lender.account.address, 300_000_000n] });
  await send(await lender.writeContract({ address: USDG, abi: erc20Abi, functionName: 'approve', args: [market.market, 300_000_000n] }));
  await send(await lender.writeContract({ address: market.market, abi: marketAbi!, functionName: 'deposit', args: [300_000_000n, lender.account.address] }));
  const limit = await client.readContract({ address: market.lens, abi: lensAbi!, functionName: 'maxBorrow', args: [POSITION] });
  await sendAs(borrower, { address: market.market, abi: marketAbi!, functionName: 'borrow', args: [POSITION, limit, borrower] });

  const loan = await client.readContract({ address: market.market, abi: marketAbi!, functionName: 'loanOf', args: [POSITION] }) as { poolKeyId: Hex };
  const own: PoolKey = { id: loan.poolKeyId, currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, observationAgeSeconds: null };
  const healthFactor = () => client.readContract({ address: market.lens, abi: lensAbi!, functionName: 'liquidationHealthFactor', args: [POSITION] }) as Promise<bigint>;
  let snapshot = await test.snapshot();

  return {
    url, market, recorder, bot: privateKeyToAccount(BOT_KEY).address,
    candidate: { market: market.market, tokenId: POSITION, poolId: own.id, tier: 1, poolKey: own },
    setEthPrice: (price) => setAnswer(ethFeed, price),
    async dropEthUntilHealthFactor(low, high) {
      for (let price = ETH_AT_POOL_SPOT; price > ETH_AT_POOL_SPOT / 2n; price = price * 99n / 100n) {
        await setAnswer(ethFeed, price);
        const current = await healthFactor();
        if (current >= low && current < high) return price;
        if (current < low) break;
      }
      throw new Error(`no ETH price puts the loan's health factor inside [${low}, ${high})`);
    },
    healthFactor,
    debt: () => client.readContract({ address: market.market, abi: marketAbi!, functionName: 'debtOf', args: [POSITION] }) as Promise<bigint>,
    usdgOf: (account) => client.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    nonceOf: (account) => client.getTransactionCount({ address: account }),
    holderOfPosition: () => client.readContract({ address: POSITION_MANAGER, abi: positionManagerAbi, functionName: 'ownerOf', args: [POSITION] }).catch(() => undefined),
    async reset() {
      await test.revert({ id: snapshot });
      snapshot = await test.snapshot();
    },
    stop: () => { anvil.kill(); },
  };
}
