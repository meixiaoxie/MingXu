import { describe, expect, it, vi } from "vitest";

import { retryProviderRequest } from "../src/models/provider-retry.js";

describe("retryProviderRequest", () => {
  it("retries retryable failures until success", async () => {
    let attempts = 0;
    const result = await retryProviderRequest(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("rate limited"), { retryable: true, retryAfterMs: 0 });
      }
      return "ok";
    }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitter: false,
      shouldRetry: (error) => Boolean((error as { retryable?: boolean }).retryable),
      getRetryAfterMs: (error) => (error as { retryAfterMs?: number }).retryAfterMs,
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("stops immediately for non-retryable failures", async () => {
    let attempts = 0;
    await expect(retryProviderRequest(async () => {
      attempts += 1;
      throw Object.assign(new Error("auth failed"), { retryable: false });
    }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitter: false,
      shouldRetry: (error) => Boolean((error as { retryable?: boolean }).retryable),
    })).rejects.toThrow("auth failed");
    expect(attempts).toBe(1);
  });
});
