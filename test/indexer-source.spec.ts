import { afterEach, describe, expect, it, vi } from 'vitest';
import { PonderIndexerSource } from '../src/indexer-source.js';

describe('PonderIndexerSource', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects an indexer lag above the configured maximum before selection', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 * 1_000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ timestamp: 999_939 }), { status: 200 })));
    await expect(new PonderIndexerSource('http://indexer.local', 60).assertFresh()).rejects.toThrow('Indexer is too far behind');
  });
});
