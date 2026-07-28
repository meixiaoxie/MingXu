import { describe, expect, it } from "vitest";

import { ModelExecutor } from "../src/models/index.js";
import type { ModelAdapter } from "../src/models/index.js";

describe("ModelExecutor Stage D", () => {
  it("retries retryable provider failures and preserves metadata on success", async () => {
    let attempts = 0;
    const adapter: ModelAdapter = {
      provider: "retry-provider",
      capabilities: {
        supportsTools: true,
        supportsStreaming: false,
        supportsImages: false,
        supportsStructuredOutput: false,
        supportsRefusal: false,
        supportsFallback: false,
        supportsEffort: false,
        supportsPromptCaching: false,
        supportsMidConversationSystem: false,
        maxContext: 1024,
        maxOutput: 256,
      },
      async generate() {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("retry me");
          throw Object.assign(error, { status: 429, retryAfterMs: 0 });
        }
        return {
          text: "recovered",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { totalTokens: 10 },
        };
      },
    };

    const executor = new ModelExecutor(adapter, { provider: "retry-provider", model: "retry-model" });
    const output = await executor.generate({
      input: { messages: [{ role: "user", content: "hello" }] },
      context: {
        runId: "run-1",
        turnId: "turn-1",
        traceId: "trace-1",
        schemaVersion: "test",
        sequence: 1,
        startedAt: "2026-07-28T00:00:00.000Z",
      },
    });

    expect(attempts).toBe(3);
    expect(output).toEqual({
      content: "recovered",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { totalTokens: 10 },
      providerRequestId: "retry-provider:request",
    });
  });

  it("does not retry non-retryable auth failures", async () => {
    let attempts = 0;
    const adapter: ModelAdapter = {
      provider: "auth-provider",
      capabilities: {
        supportsTools: true,
        supportsStreaming: false,
        supportsImages: false,
        supportsStructuredOutput: false,
        supportsRefusal: false,
        supportsFallback: false,
        supportsEffort: false,
        supportsPromptCaching: false,
        supportsMidConversationSystem: false,
        maxContext: 1024,
        maxOutput: 256,
      },
      async generate() {
        attempts += 1;
        const error = new Error("unauthorized");
        throw Object.assign(error, { status: 401 });
      },
    };

    const executor = new ModelExecutor(adapter, { provider: "auth-provider", model: "auth-model" });
    await expect(executor.generate({
      input: { messages: [{ role: "user", content: "hello" }] },
      context: {
        runId: "run-1",
        turnId: "turn-1",
        traceId: "trace-1",
        schemaVersion: "test",
        sequence: 1,
        startedAt: "2026-07-28T00:00:00.000Z",
      },
    })).rejects.toMatchObject({
      name: "ModelExecutionError",
      details: { code: "auth_error", retryable: false },
    });
    expect(attempts).toBe(1);
  });
});
