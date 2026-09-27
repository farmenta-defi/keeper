import { describe, expect, it, vi } from 'vitest';
import { retryWithBackoff } from '../src/retry.js';

describe('retryWithBackoff', () => {
  it('waits 1s then 2s after two rate limits before returning', async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error('429')).mockRejectedValueOnce(new Error('429')).mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(retryWithBackoff(operation, sleep)).resolves.toBe('ok');
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000);
  });
});
