import { describe, expect, it, vi } from 'vitest';
import { IndexerSource } from '../src/indexer-source.js';

const market = '0x0000000000000000000000000000000000000001' as const;
const poolId = `0x${'0'.repeat(64)}` as const;

describe('IndexerSource', () => {
  it('combines meme candidates with in-custody blue-chip loans without duplicates', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ market, tokenId: '4', poolId, tier: 2 }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [
        { market, tokenId: '4', poolId, tier: 2, everBorrowed: true },
        { market, tokenId: '8', poolId, tier: 1, everBorrowed: true },
        { market, tokenId: '9', poolId, tier: 1, everBorrowed: false },
      ] }), { status: 200 }));
    const source = new IndexerSource('http://indexer', [market], fetcher);

    await expect(source.candidates()).resolves.toEqual([
      { market, tokenId: 4n, poolId, tier: 2 },
      { market, tokenId: 8n, poolId, tier: 1 },
    ]);
    expect(fetcher).toHaveBeenNthCalledWith(1, 'http://indexer/loans/keeper-candidates', expect.anything());
    expect(fetcher).toHaveBeenNthCalledWith(2, `http://indexer/loans?status=in_custody&market=${market}`, expect.anything());
  });
});
