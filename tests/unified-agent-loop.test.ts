import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineTool, JsonlSessionStore, runAgentLoop } from "../src/index.js";
import type { ModelInput, ModelProvider } from "../src/index.js";

async function withSessionStore(
  operation: (store: JsonlSessionStore) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mingxu-unified-session-"));
  try {
    await operation(new JsonlSessionStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("unified agent loop", () => {
  it("runs afterToolCall once and feeds its final output and context back to the model", async () => {
    const afterToolCall = vi.fn(async () => ({ output: "rewritten", additionalContext: "trusted context" }));
    const seen: ModelInput[] = [];
    const model: ModelProvider = {
      async generate(input) {
        seen.push(input);
        if (!input.messages.some((message) => message.role === "tool")) {
          return { content: "", toolCalls: [{ id: "tool-1", name: "echo", input: { value: 1 } }] };
        }
        return { content: "done", toolCalls: [] };
      },
    };
    const tool = defineTool({
      name: "echo",
      description: "Echo input.",
      inputSchema: z.object({ value: z.number() }),
      execute: ({ value }) => value,
    });

    const result = await runAgentLoop("start", { model, tools: [tool], hooks: { afterToolCall } });

    expect(result.content).toBe("done");
    expect(afterToolCall).toHaveBeenCalledOnce();
    expect(seen[1]?.messages.find((message) => message.role === "tool")?.content).toContain("trusted context");
    expect(result.messages.find((message) => message.role === "tool")).toMatchObject({
      toolResult: { output: "rewritten" },
    });
  });

  it("bounds parallel tools and preserves model-declared result order", async () => {
    let active = 0;
    let peak = 0;
    const makeTool = (name: string, delay: number) => defineTool({
      name,
      description: `Run ${name}.`,
      executionMode: "parallel",
      inputSchema: z.object({}),
      async execute() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, delay));
        active -= 1;
        return name;
      },
    });
    const model: ModelProvider = {
      generate: vi.fn()
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [
            { id: "one", name: "one", input: {} },
            { id: "two", name: "two", input: {} },
            { id: "three", name: "three", input: {} },
          ],
        })
        .mockResolvedValueOnce({ content: "done", toolCalls: [] }),
    };

    const result = await runAgentLoop("start", {
      model,
      tools: [makeTool("one", 30), makeTool("two", 5), makeTool("three", 1)],
      runtimeLimits: { maxConcurrentTools: 2 },
    });

    expect(peak).toBe(2);
    expect(result.messages.filter((message) => message.role === "tool").map((message) => message.toolResult.name))
      .toEqual(["one", "two", "three"]);
  });

  it("persists a terminal failed run when max iterations is reached", async () => {
    const model: ModelProvider = {
      async generate() {
        return { content: "", toolCalls: [{ id: "tool-loop", name: "loop", input: {} }] };
      },
    };
    const tool = defineTool({
      name: "loop",
      description: "Continue the loop.",
      inputSchema: z.object({}),
      execute: () => "again",
    });

    await withSessionStore(async (store) => {
      const result = await runAgentLoop("start", { model, tools: [tool], sessionStore: store, maxIterations: 1 });
      const document = await store.getRequiredSession(result.sessionId!);
      expect(result.terminationReason).toBe("max_iterations");
      expect(document.runs.at(-1)).toMatchObject({ state: "failed", terminationReason: "max_iterations" });
    });
  });

  it.each([
    ["max_model_requests", { maxModelRequests: 1 }],
    ["max_tool_calls", { maxToolCalls: 1 }],
    ["max_duration", { maxDurationMs: 1 }],
  ] as const)("persists %s as a terminal run", async (reason, runtimeLimits) => {
    await withSessionStore(async (store) => {
      const model: ModelProvider = {
        async generate() {
          if (reason === "max_duration") await new Promise((resolve) => setTimeout(resolve, 5));
          return { content: "", toolCalls: [{ id: "tool-loop", name: "loop", input: {} }] };
        },
      };
      const tool = defineTool({
        name: "loop",
        description: "Continue the loop.",
        inputSchema: z.object({}),
        execute: () => "again",
      });

      const result = await runAgentLoop("start", {
        model,
        tools: [tool],
        sessionStore: store,
        runtimeLimits,
      });
      const document = await store.getRequiredSession(result.sessionId!);
      expect(result.terminationReason).toBe(reason);
      expect(document.runs.at(-1)).toMatchObject({
        state: reason === "max_duration" ? "timed_out" : "failed",
        terminationReason: reason,
      });
    });
  });

  it("persists model errors and aborts before rethrowing", async () => {
    await withSessionStore(async (store) => {
      const model: ModelProvider = { generate: vi.fn(async () => { throw new Error("provider failed"); }) };
      await expect(runAgentLoop("start", { model, sessionStore: store })).rejects.toThrow("provider failed");
      const failed = await store.getRequiredSession((await store.listRecentSessions())[0]!.sessionId);
      expect(failed.runs.at(-1)).toMatchObject({ state: "failed", terminationReason: "model_error" });
      expect(failed.runs.at(-1)?.turns.at(-1)?.messages).toContainEqual({ role: "user", content: "start" });
    });

    await withSessionStore(async (store) => {
      const controller = new AbortController();
      controller.abort(new DOMException("cancelled", "AbortError"));
      const model: ModelProvider = {
        async generate() {
          controller.signal.throwIfAborted();
          return { content: "never", toolCalls: [] };
        },
      };
      await expect(runAgentLoop("start", { model, sessionStore: store, signal: controller.signal })).rejects.toThrow();
      const cancelled = await store.getRequiredSession((await store.listRecentSessions())[0]!.sessionId);
      expect(cancelled.runs.at(-1)).toMatchObject({ state: "cancelled", terminationReason: "aborted" });
    });
  });

  it("persists a timed out run when a tool exceeds its deadline", async () => {
    await withSessionStore(async (store) => {
      const model: ModelProvider = {
        async generate() {
          return { content: "", toolCalls: [{ id: "slow-1", name: "slow", input: {} }] };
        },
      };
      const tool = defineTool({
        name: "slow",
        description: "Wait until cancelled.",
        inputSchema: z.object({}),
        async execute(_input, context) {
          await new Promise((_resolve, reject) => {
            context?.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
          });
        },
      });

      const result = await runAgentLoop("start", { model, tools: [tool], sessionStore: store, timeoutMs: 10 });
      const document = await store.getRequiredSession(result.sessionId!);
      expect(result.terminationReason).toBe("tool_timeout");
      expect(document.runs.at(-1)).toMatchObject({ state: "timed_out", terminationReason: "tool_timeout" });
      expect(document.runs.at(-1)?.turns.at(-1)?.messages.some((message) => message.role === "tool")).toBe(true);
    });
  });

  it("requires approval for hook ask and fails closed for high-risk tools without healthy audit", async () => {
    const execute = vi.fn(async () => "executed");
    const tool = defineTool({
      name: "guarded",
      description: "A governed tool.",
      inputSchema: z.object({}),
      execute,
    });
    const model: ModelProvider = {
      async generate(input) {
        return input.messages.some((message) => message.role === "tool")
          ? { content: "done", toolCalls: [] }
          : { content: "", toolCalls: [{ id: "guarded-1", name: "guarded", input: {} }] };
      },
    };
    const events: string[] = [];
    const asked = await runAgentLoop("start", {
      model,
      tools: [tool],
      interactive: true,
      hooks: { beforeToolCall: async () => ({ behavior: "ask", reason: "confirm" }) },
      eventSink: {
        emit: async (event) => { events.push(event.eventType); },
        isHealthy: () => true,
      },
    });
    expect(asked.terminationReason).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
    expect(events).toContain("approval.missing");

    const highRiskTool = { ...tool, riskLevel: "high" as const };
    await expect(runAgentLoop("start", {
      model,
      tools: [highRiskTool],
      audit: { failClosedForHighRisk: true },
      eventSink: { emit: async () => {}, isHealthy: () => false },
    })).rejects.toThrow("requires a healthy audit sink");
    expect(execute).not.toHaveBeenCalled();
  });
});
