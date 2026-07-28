import { describe, expect, it } from "vitest";

import { ModelExecutor, toModelOutput, toModelRequest } from "../src/models/index.js";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../src/models/index.js";
import type { ModelInput, RunContext } from "../src/index.js";

describe("ModelExecutor and request builder", () => {
  it("converts runtime input to provider request and preserves response metadata", async () => {
    const input: ModelInput = {
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
      systemPrompt: "Be concise.",
    };
    const request = toModelRequest(input, { provider: "anthropic", model: "claude-sonnet-5" });
    expect(request).toEqual({
      modelId: "claude-sonnet-5",
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
      system: "Be concise.",
    });

    const response: ModelResponse = {
      text: "Done",
      toolCalls: [{ id: "tool-1", name: "echo", input: { message: "hi" } }],
      stopReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      refusal: "none",
      errors: ["soft-warning"],
      rawProviderData: { provider: "anthropic" },
    };
    expect(toModelOutput(response, "anthropic")).toEqual({
      content: "Done",
      toolCalls: [{ id: "tool-1", name: "echo", input: { message: "hi" } }],
      stopReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      refusal: "none",
      providerRequestId: "anthropic:request",
      errors: ["soft-warning"],
      rawProviderData: { provider: "anthropic" },
    });
  });

  it("routes provider calls through ModelExecutor", async () => {
    const recordedRequests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      provider: "custom-adapter",
      capabilities: {
        supportsTools: true,
        supportsStreaming: false,
        supportsImages: false,
        supportsStructuredOutput: false,
        supportsRefusal: true,
        supportsFallback: false,
        supportsEffort: false,
        supportsPromptCaching: false,
        supportsMidConversationSystem: false,
        maxContext: 1000,
        maxOutput: 100,
      },
      async generate(request) {
        recordedRequests.push(request);
        return {
          text: "executor answer",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { totalTokens: 12 },
        };
      },
    };
    const executor = new ModelExecutor(adapter, { provider: "custom-adapter", model: "local-model" });
    const context: RunContext = {
      runId: "run-1",
      turnId: "turn-1",
      traceId: "trace-1",
      schemaVersion: "test",
      sequence: 1,
      startedAt: "2026-07-28T00:00:00.000Z",
    };

    const output = await executor.generate({
      input: { messages: [{ role: "user", content: "Hi" }] },
      context,
    });

    expect(recordedRequests).toEqual([
      {
        modelId: "local-model",
        messages: [{ role: "user", content: "Hi" }],
      },
    ]);
    expect(output).toEqual({
      content: "executor answer",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { totalTokens: 12 },
      providerRequestId: "custom-adapter:request",
    });
  });
});
