import { describe, expect, it, vi } from "vitest";

import { InMemoryApprovalStore } from "../src/approval/in-memory-approval-store.js";
import { executeToolLifecycle, ToolExecutor, ToolRegistry } from "../src/index.js";
import type { Tool } from "../src/index.js";
import type { PolicyEngine } from "../src/policy/types.js";

function createContext() {
  return {
    runId: "run-1",
    turnId: "run-1:turn:1",
    traceId: "trace-1",
    schemaVersion: "test",
    sequence: 1,
    startedAt: "2026-07-28T00:00:00.000Z",
  };
}

describe("tool lifecycle", () => {
  it("emits policy and approval events for blocked and approved tools", async () => {
    const emitted: string[] = [];
    const eventSink = {
      emit: vi.fn(async (event: { eventType: string }) => {
        emitted.push(event.eventType);
      }),
      isHealthy: () => true,
    };

    const blockedTool: Tool = {
      name: "blocked",
      description: "Blocked tool.",
      inputSchema: {},
      async execute() {
        return "should not run";
      },
    };
    const blockedRegistry = new ToolRegistry([blockedTool]);
    const blockedExecutor = { execute: vi.fn() } as unknown as ToolExecutor;
    const blockedPolicy: PolicyEngine = {
      evaluate: vi.fn(async () => ({
        effect: "deny" as const,
        reason: "blocked by policy",
        ruleVersion: "test",
      })),
    };

    await executeToolLifecycle({
      name: "blocked",
      input: {},
      toolCallId: "tool-1",
      context: createContext(),
    }, {
      registry: blockedRegistry,
      executor: blockedExecutor,
      policy: blockedPolicy,
      approvalStore: new InMemoryApprovalStore(),
      eventSink,
      audit: undefined,
      principalId: "local-user",
      interactive: false,
    });

    const approvalStore = new InMemoryApprovalStore();
    await approvalStore.add({
      id: "approval-1",
      requestFingerprint: JSON.stringify({
        principal: { kind: "user", id: "local-user" },
        action: { kind: "tool.call", name: "approved" },
        resource: { kind: "tool", toolName: "approved" },
        normalizedInput: { value: 1 },
      }),
      principalId: "local-user",
      actionKind: "tool.call",
      resourceScope: "approved",
      operator: "local-user",
      decision: "allow",
      createdAt: new Date().toISOString(),
    });
    const approvedTool: Tool = {
      name: "approved",
      description: "Approved tool.",
      inputSchema: {},
      async execute(input) {
        return { echoed: input };
      },
    };
    const approvedRegistry = new ToolRegistry([approvedTool]);
    const approvedExecutor = new ToolExecutor(approvedRegistry);
    const approvedPolicy: PolicyEngine = {
      evaluate: vi.fn(async () => ({
        effect: "ask" as const,
        reason: "needs approval",
        ruleVersion: "test",
      })),
    };

    await executeToolLifecycle({
      name: "approved",
      input: { value: 1 },
      toolCallId: "tool-2",
      context: createContext(),
    }, {
      registry: approvedRegistry,
      executor: approvedExecutor,
      policy: approvedPolicy,
      approvalStore,
      eventSink,
      audit: undefined,
      principalId: "local-user",
      interactive: true,
    });

    expect(emitted).toContain("policy.decision");
    expect(emitted).toContain("tool.execution_blocked");
    expect(emitted).toContain("approval.matched");
    expect(emitted).toContain("tool.execution_allowed");
  });

  it("denies execution before the tool runs when policy blocks it", async () => {
    const tool: Tool = {
      name: "blocked",
      description: "Blocked tool.",
      inputSchema: {},
      async execute() {
        return "should not run";
      },
    };
    const registry = new ToolRegistry([tool]);
    const execute = vi.fn(async () => ({
      invocation: {
        invocationId: "run-1:turn:1:tool:tool-1",
        runId: "run-1",
        turnId: "run-1:turn:1",
        toolCallId: "tool-1",
        toolName: "blocked",
        state: "completed" as const,
        input: {},
        output: "should not run",
      },
      toolResult: {
        toolCallId: "tool-1",
        name: "blocked",
        output: "should not run",
      },
    }));
    const executor = { execute } as unknown as ToolExecutor;
    const policy: PolicyEngine = {
      evaluate: vi.fn(async () => ({
        effect: "deny" as const,
        reason: "blocked by policy",
        ruleVersion: "test",
      })),
    };

    const result = await executeToolLifecycle({
      name: "blocked",
      input: {},
      toolCallId: "tool-1",
      context: createContext(),
    }, {
      registry,
      executor,
      policy,
      approvalStore: new InMemoryApprovalStore(),
      eventSink: undefined,
      audit: undefined,
      principalId: "local-user",
      interactive: false,
    });

    expect(result.outcome).toBe("blocked");
    expect(result.toolResult).toMatchObject({
      toolCallId: "tool-1",
      name: "blocked",
      isError: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs the tool when approval matches", async () => {
    const tool: Tool = {
      name: "approved",
      description: "Approved tool.",
      inputSchema: {},
      async execute(input) {
        return { echoed: input };
      },
    };
    const registry = new ToolRegistry([tool]);
    const executor = new ToolExecutor(registry);
    const approvalStore = new InMemoryApprovalStore();
    await approvalStore.add({
      id: "approval-1",
      requestFingerprint: JSON.stringify({
        principal: { kind: "user", id: "local-user" },
        action: { kind: "tool.call", name: "approved" },
        resource: { kind: "tool", toolName: "approved" },
        normalizedInput: { value: 1 },
      }),
      principalId: "local-user",
      actionKind: "tool.call",
      resourceScope: "approved",
      operator: "local-user",
      decision: "allow",
      createdAt: new Date().toISOString(),
    });
    const policy: PolicyEngine = {
      evaluate: vi.fn(async () => ({
        effect: "ask" as const,
        reason: "needs approval",
        ruleVersion: "test",
      })),
    };

    const result = await executeToolLifecycle({
      name: "approved",
      input: { value: 1 },
      toolCallId: "tool-1",
      context: createContext(),
    }, {
      registry,
      executor,
      policy,
      approvalStore,
      eventSink: undefined,
      audit: undefined,
      principalId: "local-user",
      interactive: true,
    });

    expect(result.outcome).toBe("executed");
    expect(result.execution?.toolResult).toEqual({
      toolCallId: "tool-1",
      name: "approved",
      output: { echoed: { value: 1 } },
    });
  });
});
