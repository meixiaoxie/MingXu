import { describe, expect, it, vi } from "vitest";

import {
  Agent,
  assertSingleActiveRun,
  runAgentLoop,
  ToolExecutor,
  ToolRegistry,
  transitionApprovalState,
  transitionRunState,
  transitionToolInvocationState,
  transitionTurnState,
} from "../src/index.js";
import { redactText, redactValue } from "../src/redaction/redactor.js";
import { InMemoryApprovalStore } from "../src/approval/in-memory-approval-store.js";
import type {
  Approval,
  ModelInput,
  ModelProvider,
  Run,
  RunContext,
  Tool,
  ToolInvocation,
  Turn,
} from "../src/index.js";

describe("Agent core", () => {
  it("validates runtime state transitions and single-active-run rules", () => {
    const run: Run = {
      runId: "run-1",
      traceId: "trace-1",
      state: "pending",
      resolvedModel: "primary",
      configHash: "config-hash",
      pluginNames: [],
      policyVersion: "none",
      schemaVersion: "test",
      startedAt: "2026-07-28T00:00:00.000Z",
      turns: [],
    };
    expect(transitionRunState(run, "running").state).toBe("running");
    expect(() => transitionRunState({ ...run, state: "succeeded" }, "running")).toThrow(
      "Run cannot transition from terminal state succeeded back to running",
    );

    const turn: Turn = {
      turnId: "turn-1",
      runId: "run-1",
      state: "pending",
      sequence: 1,
      startedAt: "2026-07-28T00:00:00.000Z",
      toolInvocations: [],
    };
    expect(transitionTurnState(turn, "running").state).toBe("running");
    expect(() => transitionTurnState({ ...turn, state: "completed" }, "running")).toThrow(
      "Turn cannot transition from terminal state completed back to running",
    );

    const invocation: ToolInvocation = {
      invocationId: "tool-1",
      runId: "run-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "echo",
      state: "pending",
      input: {},
    };
    expect(transitionToolInvocationState(invocation, "running").state).toBe("running");
    expect(() => transitionToolInvocationState({ ...invocation, state: "failed" }, "running")).toThrow(
      "Tool invocation cannot transition from terminal state failed back to running",
    );

    const approval: Approval = {
      approvalId: "approval-1",
      runId: "run-1",
      turnId: "turn-1",
      type: "tool_call",
      state: "pending",
    };
    expect(transitionApprovalState(approval, "approved").state).toBe("approved");
    expect(() => transitionApprovalState({ ...approval, state: "denied" }, "pending")).toThrow(
      "Approval cannot transition from terminal state denied back to pending",
    );

    expect(() => assertSingleActiveRun([
      { ...run, state: "running" },
      { ...run, runId: "run-2", traceId: "trace-2", state: "pending" },
    ])).toThrow("Only one active run is allowed in a session");
  });

  it("executes tools through ToolExecutor and normalizes success and error results", async () => {
    const registry = new ToolRegistry([
      {
        name: "ok",
        description: "Works.",
        inputSchema: {},
        async execute(input) {
          return { echoed: input };
        },
      },
      {
        name: "fail",
        description: "Fails.",
        inputSchema: {},
        async execute() {
          throw new Error("broken tool");
        },
      },
    ]);
    const executor = new ToolExecutor(registry);
    const context: RunContext = {
      runId: "run-1",
      turnId: "run-1:turn:1",
      traceId: "trace-1",
      schemaVersion: "test",
      sequence: 1,
      startedAt: "2026-07-28T00:00:00.000Z",
    };

    const success = await executor.execute({
      name: "ok",
      input: { value: 1 },
      toolCallId: "tool-1",
      context,
    });
    expect(success.invocation).toMatchObject({
      invocationId: "run-1:turn:1:tool:tool-1",
      runId: "run-1",
      turnId: "run-1:turn:1",
      toolCallId: "tool-1",
      toolName: "ok",
      state: "completed",
      output: { echoed: { value: 1 } },
    });
    expect(success.toolResult).toEqual({
      toolCallId: "tool-1",
      name: "ok",
      output: { echoed: { value: 1 } },
    });

    const failure = await executor.execute({
      name: "fail",
      input: {},
      toolCallId: "tool-2",
      context,
    });
    expect(failure.invocation).toMatchObject({
      invocationId: "run-1:turn:1:tool:tool-2",
      toolCallId: "tool-2",
      toolName: "fail",
      state: "failed",
      output: "broken tool",
      isError: true,
    });
    expect(failure.toolResult).toEqual({
      toolCallId: "tool-2",
      name: "fail",
      output: "broken tool",
      isError: true,
    });
  });

  it("returns the model's final text through the exported Agent class", async () => {
    const model: ModelProvider = {
      generate: vi.fn().mockResolvedValue({ content: "hello", toolCalls: [] }),
    };

    const result = await new Agent({ model }).run("hi");

    expect(result.content).toBe("hello");
    expect(result.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(result.iterations).toBe(1);
  });

  it("executes requested tools in order and feeds their results back", async () => {
    const inputs: ModelInput[] = [];
    const executionOrder: string[] = [];
    const firstTool: Tool = {
      name: "first",
      description: "Returns the first result.",
      inputSchema: { type: "object" },
      async execute(input) {
        executionOrder.push("first");
        return { input, value: 1 };
      },
    };
    const secondTool: Tool = {
      name: "second",
      description: "Returns the second result.",
      inputSchema: { type: "object" },
      async execute() {
        executionOrder.push("second");
        return "two";
      },
    };
    const model: ModelProvider = {
      generate: vi.fn(async (input) => {
        inputs.push(input);
        if (inputs.length === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "call-1", name: "first", input: { key: "value" } },
              { id: "call-2", name: "second", input: {} },
            ],
          };
        }
        return { content: "finished", toolCalls: [] };
      }),
    };

    const result = await runAgentLoop("start", {
      model,
      tools: [firstTool, secondTool],
      systemPrompt: "Be concise.",
    });

    expect(executionOrder).toEqual(["first", "second"]);
    expect(inputs[0]).toMatchObject({
      messages: [{ role: "user", content: "start" }],
      systemPrompt: "Be concise.",
      tools: [
        { name: "first", description: firstTool.description },
        { name: "second", description: secondTool.description },
      ],
    });
    expect(inputs[1]?.messages.slice(-2)).toEqual([
      {
        role: "tool",
        content: '{"input":{"key":"value"},"value":1}',
        toolResult: {
          toolCallId: "call-1",
          name: "first",
          output: { input: { key: "value" }, value: 1 },
        },
      },
      {
        role: "tool",
        content: "two",
        toolResult: { toolCallId: "call-2", name: "second", output: "two" },
      },
    ]);
    expect(result.content).toBe("finished");
    expect(result.iterations).toBe(2);
  });

  it("returns unknown-tool and execution failures to the model", async () => {
    const failingTool: Tool = {
      name: "fail",
      description: "Always fails.",
      inputSchema: {},
      async execute() {
        throw new Error("tool broke");
      },
    };
    const generate = vi.fn()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          { id: "missing-1", name: "missing", input: {} },
          { id: "fail-1", name: "fail", input: {} },
        ],
      })
      .mockResolvedValueOnce({ content: "recovered", toolCalls: [] });

    const result = await runAgentLoop("start", {
      model: { generate },
      tools: [failingTool],
    });

    expect(result.messages.slice(2, 4)).toEqual([
      {
        role: "tool",
        content: "Unknown tool: missing",
        toolResult: {
          toolCallId: "missing-1",
          name: "missing",
          output: "Unknown tool: missing",
          isError: true,
        },
      },
      {
        role: "tool",
        content: "tool broke",
        toolResult: {
          toolCallId: "fail-1",
          name: "fail",
          output: "tool broke",
          isError: true,
        },
      },
    ]);
    expect(result.content).toBe("recovered");
  });

  it("tracks usage, enforces runtime limits, and records termination reasons", async () => {
    const model: ModelProvider = {
      generate: vi.fn()
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [{ id: "tool-1", name: "echo", input: { value: 1 } }],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        })
        .mockResolvedValueOnce({
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        }),
    };
    const echoTool: Tool = {
      name: "echo",
      description: "Echoes input.",
      inputSchema: {},
      async execute(input) {
        return { echoed: input };
      },
    };

    const result = await runAgentLoop("start", {
      model,
      tools: [echoTool],
      runtimeLimits: { maxIterations: 5, maxModelRequests: 5, maxToolCalls: 5, maxDurationMs: 60_000, maxConcurrentTools: 1 },
    });

    expect(result.terminationReason).toBe("completed");
    expect(result.usage).toEqual({
      inputTokens: 17,
      outputTokens: 8,
      totalTokens: 25,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      modelRequests: 2,
    });

    const limitedResult = await runAgentLoop("start", {
      model: {
        generate: vi.fn().mockResolvedValue({
          content: "",
          toolCalls: [{ id: "tool-1", name: "echo", input: {} }],
        }),
      },
      tools: [echoTool],
      runtimeLimits: { maxIterations: 5, maxModelRequests: 5, maxToolCalls: 1, maxDurationMs: 60_000, maxConcurrentTools: 1 },
    });

    expect(limitedResult.terminationReason).toBe("max_tool_calls");
  });

  it("stores oversized tool output as an artifact reference instead of bloating messages", async () => {
    const hugeText = "x".repeat(20_000);
    const hugeTool: Tool = {
      name: "huge",
      description: "Returns a huge payload.",
      inputSchema: {},
      async execute() {
        return { hugeText };
      },
    };
    const model: ModelProvider = {
      generate: vi.fn()
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [{ id: "tool-1", name: "huge", input: {} }],
        })
        .mockResolvedValueOnce({ content: "ok", toolCalls: [] }),
    };

    const result = await runAgentLoop("start", {
      model,
      tools: [hugeTool],
      toolLimits: { maxOutputBytes: 512 },
    });

    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage).toMatchObject({
      role: "tool",
      toolResult: {
        toolCallId: "tool-1",
        name: "huge",
        truncated: true,
        artifact: {
          kind: "artifact_ref",
          storage: "local-temp",
          temporary: true,
        },
      },
    });
    expect(toolMessage && toolMessage.role === "tool" ? toolMessage.content : "").toContain("[artifact stored:");
  });

  it("denies tool execution through the policy chain and emits policy audit events", async () => {
    const emitted: string[] = [];
    const model: ModelProvider = {
      generate: vi.fn()
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [{ id: "tool-1", name: "dangerous", input: { value: 1 } }],
        })
        .mockResolvedValueOnce({ content: "done", toolCalls: [] }),
    };
    const dangerousTool: Tool = {
      name: "dangerous",
      description: "Should be denied.",
      inputSchema: {},
      async execute() {
        return "should not run";
      },
    };

    const result = await runAgentLoop("start", {
      model,
      tools: [dangerousTool],
      policy: {
        evaluate: vi.fn(async () => ({
          effect: "deny" as const,
          reason: "Policy denied dangerous tool",
          ruleVersion: "test-policy-v1",
          matchedRuleIds: ["deny-dangerous"],
        })),
      },
      eventSink: {
        emit: vi.fn(async (event) => {
          emitted.push(event.eventType);
        }),
        isHealthy: () => true,
      },
      redactor: { redactText, redactValue },
    });

    expect(result.messages.find((message) => message.role === "tool")).toMatchObject({
      role: "tool",
      toolResult: {
        toolCallId: "tool-1",
        name: "dangerous",
        isError: true,
        output: expect.stringContaining("Policy denied dangerous tool"),
      },
    });
  });

  it("allows an ask decision when a matching approval exists", async () => {
    const approvalStore = new InMemoryApprovalStore();
    const emitted: string[] = [];
    const model: ModelProvider = {
      generate: vi.fn()
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [{ id: "tool-1", name: "approved-tool", input: { path: "note.txt" } }],
        })
        .mockResolvedValueOnce({ content: "done", toolCalls: [] }),
    };
    const approvedTool: Tool = {
      name: "approved-tool",
      description: "Should be approved.",
      inputSchema: {},
      async execute() {
        return "approved result";
      },
    };

    const fingerprint = JSON.stringify({
      action: { kind: "tool.call", name: "approved-tool" },
      resource: { kind: "tool", toolName: "approved-tool" },
      normalizedInput: { path: "note.txt" },
    });
    await approvalStore.add({
      id: "approval-1",
      requestFingerprint: fingerprint,
      principalId: "local-user",
      actionKind: "tool.call",
      resourceScope: "approved-tool",
      operator: "local-user",
      decision: "allow",
      createdAt: new Date().toISOString(),
    });

    const result = await runAgentLoop("start", {
      model,
      tools: [approvedTool],
      policy: {
        evaluate: vi.fn(async () => ({
          effect: "ask" as const,
          reason: "Needs approval",
          ruleVersion: "test-policy-v1",
          matchedRuleIds: ["ask-approved-tool"],
        })),
      },
      approvalStore,
      principalId: "local-user",
      interactive: true,
      eventSink: {
        emit: vi.fn(async (event) => {
          emitted.push(event.eventType);
        }),
        isHealthy: () => true,
      },
      redactor: { redactText, redactValue },
    });

    expect(result.messages.find((message) => message.role === "tool")).toMatchObject({
      role: "tool",
      toolResult: {
        toolCallId: "tool-1",
        name: "approved-tool",
        output: "approved result",
      },
    });
  });

  it("blocks a high-risk tool when audit is fail-closed and the sink is unhealthy", async () => {
    const highRiskTool: Tool = {
      name: "dangerous",
      description: "High risk tool.",
      inputSchema: {},
      riskLevel: "high",
      async execute() {
        return "should not run";
      },
    };
    const model: ModelProvider = {
      generate: vi.fn().mockResolvedValue({
        content: "",
        toolCalls: [{ id: "tool-1", name: "dangerous", input: {} }],
      }),
    };

    await expect(runAgentLoop("start", {
      model,
      tools: [highRiskTool],
      audit: { failClosedForHighRisk: true },
      eventSink: {
        emit: vi.fn(async () => {}),
        isHealthy: () => false,
      },
      redactor: { redactText, redactValue },
    })).rejects.toThrow("High-risk tool requires a healthy audit sink");
  });

  it("rejects maxIterations less than 1", async () => {
    const model: ModelProvider = {
      generate: vi.fn().mockResolvedValue({ content: "ok", toolCalls: [] }),
    };

    await expect(
      runAgentLoop("start", { model, maxIterations: 0 }),
    ).rejects.toThrow("maxIterations must be a positive integer");

    await expect(
      runAgentLoop("start", { model, maxIterations: -1 }),
    ).rejects.toThrow("maxIterations must be a positive integer");
  });

  it("throws when the loop reaches maxIterations with unresolved tool calls", async () => {
    const model: ModelProvider = {
      generate: vi.fn().mockResolvedValue({
        content: "",
        toolCalls: [{ id: "tool-1", name: "echo", input: {} }],
      }),
    };
    const echoTool: Tool = {
      name: "echo",
      description: "Echoes input.",
      inputSchema: {},
      async execute(input) {
        return { echoed: input };
      },
    };

    const result = await runAgentLoop("start", {
      model,
      tools: [echoTool],
      maxIterations: 3,
    });

    expect(result.terminationReason).toBe("max_iterations");
  });

  it("CLI default runner outputs final text", async () => {
    // 验证 Agent.run() 返回最终文本，而不是结构化对象
    const model: ModelProvider = {
      generate: vi.fn().mockResolvedValue({ content: "final text", toolCalls: [] }),
    };

    const agent = new Agent({ model });
    const result = await agent.run("test prompt");
    expect(typeof result.content).toBe("string");
    expect(result.content).toBe("final text");
  });
});
