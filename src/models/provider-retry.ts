export interface RetryPolicy {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxTotalDelayMs?: number;
  readonly jitter?: boolean;
  readonly signal?: AbortSignal;
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  readonly getRetryAfterMs?: (error: unknown) => number | undefined;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_MAX_TOTAL_DELAY_MS = 10_000;

export async function retryProviderRequest<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy = {},
): Promise<T> {
  const maxAttempts = policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxTotalDelayMs = policy.maxTotalDelayMs ?? DEFAULT_MAX_TOTAL_DELAY_MS;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }

  let lastError: unknown;
  let accumulatedDelayMs = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    policy.signal?.throwIfAborted();

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !(policy.shouldRetry?.(error, attempt) ?? true)) {
        throw error;
      }

      const retryAfterMs = policy.getRetryAfterMs?.(error);
      const backoffDelayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = Math.min(
        retryAfterMs ?? applyJitter(backoffDelayMs, policy.jitter ?? true),
        maxDelayMs,
      );
      accumulatedDelayMs += delayMs;
      if (accumulatedDelayMs > maxTotalDelayMs) {
        throw error;
      }
      await delay(delayMs, policy.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function applyJitter(delayMs: number, enabled: boolean): number {
  if (!enabled || delayMs <= 1) {
    return delayMs;
  }
  const spread = Math.max(1, Math.floor(delayMs * 0.1));
  const offset = Math.floor(Math.random() * (spread * 2 + 1)) - spread;
  return Math.max(0, delayMs + offset);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) {
    signal.throwIfAborted();
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason ?? new Error("Request aborted"));
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
