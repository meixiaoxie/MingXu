import { describe, expect, it } from "vitest";

import { defineTool, runAgentLoop } from "../src/index.js";
import { ModelExecutor } from "../src/models/index.js";
import type { ModelAdapter } from "../src/models/index.js";
import type { ModelInput } from "../src/index.js";

describe("Stage D runtime behavior", () => {
  it("maps aborted model execution through ModelExecutor", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("user cancelled", "AbortError"));

    const adapter: ModelAdapter = {
      provider: "demo-provider",
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
        controller.signal.throwIfAborted();
        return { text: "never", toolCalls: [] };
      },
    };

    const executor = new ModelExecutor(adapter, { provider: "demo-provider", model: "demo-model" });
    await expect(executor.generate({
      input: { messages: [{ role: "user", content: "Hi" }] },
      context: {
        runId: "run-1",
        turnId: "turn-1",
        traceId: "trace-1",
        schemaVersion: "test",
        sequence: 1,
        startedAt: "2026-07-28T00:00:00.000Z",
        signal: controller.signal,
      },
    })).rejects.toMatchObject({
      name: "ModelExecutionError",
      details: { code: "cancelled", retryable: false },
    });
  });

  it("stops when a tool times out instead of proceeding forever", async () => {
    const hangingTool = defineTool({
      name: "hang",
      description: "Never resolves before timeout.",
      inputSchema: { parse(value: unknown) { return value; } } as never,
      async execute(_input, context) {
        await new Promise((_resolve, reject) => {
          context?.signal?.addEventListener("abort", () => {
            reject(context.signal?.reason ?? new DOMException("timed out", "TimeoutError"));
          }, { once: true });
        });
        return "never";
      },
    });

    const model = {
      async generate(input: ModelInput) {
        const hasToolResult = input.messages.some((message) => message.role === "tool");
        if (!hasToolResult) {
          return {
            content: "",
            toolCalls: [{ id: "tool-1", name: "hang", input: {} }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    };

    const result = await runAgentLoop("start", {
      model,
      tools: [hangingTool],
      timeoutMs: 10,
    });
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage).toMatchObject({
      role: "tool",
      toolResult: {
        toolCallId: "tool-1",
        name: "hang",
        isError: true,
      },
    });
  });
});
