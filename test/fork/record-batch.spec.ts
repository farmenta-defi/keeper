import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PrimaryKeeperService } from '../../src/primary-service.js';
import { ViemRecorder } from '../../src/recorder.js';
import type { AlertSink, IndexerSource, PoolKey, PrimaryStore, Recorder } from '../../src/types.js';

const execute = promisify(execFile);
const forkUrl = process.env.FORK_RPC_URL;
const contracts = process.env.SMART_CONTRACT_DIR;
if (!forkUrl || !contracts) throw new Error('FORK_RPC_URL and SMART_CONTRACT_DIR are required for bun run test:fork');

const anvilKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const anvilUrl = 'http://127.0.0.1:18545';
const chain: Chain = { id: 4663, name: 'Robinhood Chain fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [anvilUrl] } } };
const stateView = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b' as Address;
const multicall3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const ids = ['0x80399a859416860c92785ff7f994e67ecbcda12d3f0adb75e0c2466b9bfacf30', '0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32', '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6', '0x30dac7167c36242d1bacfd30561d444cf014529ee55978991d03e4ee178e725a', '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982'] as const;
const makeKey = (id: `0x${string}`, currency0: Address, currency1: Address, fee: number, tickSpacing: number, hooks: Address): PoolKey => ({ id, currency0, currency1, fee, tickSpacing, hooks, observationAgeSeconds: 300 });
const keys: PoolKey[] = [
  makeKey(ids[0], '0x0000000000000000000000000000000000000000', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 0x800000, 1, '0x78257a554194C3ba10a59357B500788934F34080'),
  makeKey(ids[1], '0x0000000000000000000000000000000000000000', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 460, 9, '0x0000000000000000000000000000000000000000'),
  makeKey(ids[2], '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 200, 4, '0x0000000000000000000000000000000000000000'),
  makeKey(ids[3], '0x0000000000000000000000000000000000000000', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 0x800000, 60, '0x42554Fa546995A393D19B3880D3a4C6709298080'),
  makeKey(ids[4], '0x0000000000000000000000000000000000000000', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 500, 10, '0x0000000000000000000000000000000000000000'),
];

let anvil: ChildProcess;
let client: ReturnType<typeof createPublicClient>;
let recorderAddress: Address;

describe('recordBatch Anvil fork', () => {
  beforeAll(async () => {
    anvil = spawn('anvil', ['--fork-url', forkUrl, '--fork-block-number', '54200000', '--port', '18545'], { stdio: ['ignore', 'ignore', 'inherit'] });
    client = createPublicClient({ chain, transport: http(anvilUrl) });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { await client.getBlockNumber(); break; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
      if (attempt === 29) throw new Error('Anvil did not start');
    }
    await execute('forge', ['build'], { cwd: contracts });
    const artifact = JSON.parse(await readFile(`${contracts}/out/TwapRecorder.sol/TwapRecorder.json`, 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
    const wallet = createWalletClient({ account: privateKeyToAccount(anvilKey), chain, transport: http(anvilUrl) });
    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [stateView] });
    const receipt = await client.waitForTransactionReceipt({ hash });
    recorderAddress = receipt.contractAddress!;
  });

  afterAll(() => anvil.kill());

  it('keeps consult available through six five-minute keeper cycles', async () => {
    const onChain = new ViemRecorder(anvilUrl, anvilKey, recorderAddress, multicall3);
    const recorder: Recorder = { debts: vi.fn().mockResolvedValue(keys.map(() => 1n)), observationCounts: onChain.observationCounts.bind(onChain), submitBatch: onChain.submitBatch.bind(onChain), waitForReceipt: onChain.waitForReceipt.bind(onChain) };
    const indexer: IndexerSource = { assertFresh: vi.fn(), candidates: vi.fn().mockResolvedValue(keys.map((key, index) => ({ market: '0x0000000000000000000000000000000000000001', tokenId: BigInt(index + 1), poolId: key.id }))), pools: vi.fn().mockResolvedValue(keys) };
    const store: PrimaryStore = { saveRun: vi.fn(), dailyTotals: vi.fn().mockResolvedValue({ costUsd: 0, budgetUsd: 1 }), claimAlert: vi.fn().mockResolvedValue(false), releaseAlert: vi.fn(), heartbeat: vi.fn() };
    const alerts: AlertSink = { send: vi.fn() };
    const service = new PrimaryKeeperService(indexer, recorder, store, alerts, 2_400);
    await service.run({ dryRun: false });
    for (let cycle = 0; cycle < 6; cycle += 1) {
      await client.request({ method: 'evm_increaseTime', params: [300] } as never);
      await client.request({ method: 'evm_mine', params: [] } as never);
      await service.run({ dryRun: false });
    }
    const abi = [{ type: 'function', name: 'consult', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }, { name: 'window', type: 'uint32' }], outputs: [{ type: 'int24' }] }] as const;
    for (const key of keys) await expect(client.readContract({ address: recorderAddress, abi, functionName: 'consult', args: [key.id, 1_800] })).resolves.toBeTypeOf('number');
  });
});
