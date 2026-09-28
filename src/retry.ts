export const RETRY_DELAYS_MS = [1_000, 2_000] as const;

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try { return await operation(); } catch (error) {
      lastError = error;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) await sleep(delay);
    }
  }
  throw lastError;
}
