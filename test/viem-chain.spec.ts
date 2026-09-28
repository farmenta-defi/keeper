import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem';
import { decodeSimulationLogs } from '../src/viem-chain.js';

const events = parseAbi([
  'event Liquidate(uint256 indexed tokenId,address indexed liquidator,uint256 repaid,uint256 out0,uint256 out1,uint256 badDebt)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);

describe('ViemChain simulation log decoding', () => {
  it('decodes Liquidate and USDG Transfer logs from eth_simulateV1 calls', () => {
    const liquidationTopics = encodeEventTopics({ abi: events, eventName: 'Liquidate', args: { tokenId: 7n, liquidator: '0x0000000000000000000000000000000000000007' } });
    const liquidation = { topics: liquidationTopics, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [100n, 200n, 300n, 0n]) };
    const transferTopics = encodeEventTopics({ abi: events, eventName: 'Transfer', args: { from: '0x0000000000000000000000000000000000000008', to: '0x0000000000000000000000000000000000000007' } });
    const transfer = { topics: transferTopics, data: encodeAbiParameters([{ type: 'uint256' }], [25n]) };
    const result = decodeSimulationLogs({ calls: [{ logs: [{ address: '0x0000000000000000000000000000000000000009', ...liquidation }, { address: '0x000000000000000000000000000000000000000a', ...transfer }] }] });
    expect(result.map((event) => event.eventName)).toEqual(['Liquidate', 'Transfer']);
    expect(result[0]!.args.out0).toBe(200n);
    expect(result[1]!.args.value).toBe(25n);
  });

  it('returns no events for a reverted call without logs', () => {
    expect(decodeSimulationLogs({ calls: [{ status: '0x0', error: { data: '0xdeadbeef' }, logs: [] }] })).toEqual([]);
  });
});
