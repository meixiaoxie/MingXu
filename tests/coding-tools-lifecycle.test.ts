import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodingToolsPlugin } from "../packages/coding-tools/runtime.js";
import { InMemoryApprovalStore } from "../src/approval/in-memory-approval-store.js";
import type { RunContext, Tool } from "../src/core/types.js";
import type { RuntimeEvent } from "../src/events/types.js";
import type { PolicyEngine } from "../src/policy/types.js";
import { executeToolLifecycle } from "../src/tools/tool-lifecycle.js";
import { ToolExecutor } from "../src/tools/tool-executor.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("R6 coding-tools lifecycle", () => {
  it("shows the Diff before approval and audits bounded metadata before committing", async () => {
    const root = await workspace();
    const tool = await loadTool(root, "edit");
    const events: RuntimeEvent[] = [];
    const approvalHandler = vi.fn(async (prompt: { input: unknown }) => {
      expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("baseline\n");
      expect(prompt.input).toMatchObject({
        binding: { operation: "edit", baselineHash: expect.any(String), targetHash: expect.any(String) },
        summary: { path: "existing.txt", diffRef: expect.any(String) },
        presentation: { kind: "diff" },
      });
      expect(JSON.stringify(prompt.input)).toContain("sensitive-new-content");
      return { decision: "allow" as const, scope: "once" as const };
    });

    const result = await runLifecycle(tool, {
      input: { path: "existing.txt", content: "sensitive-new-content\n" },
      approvalHandler,
      events,
    });

    expect(result.outcome).toBe("executed");
    expect(result.toolResult).toMatchObject({ output: { committed: true } });
    expect(result.toolResult.isError).not.toBe(true);
    expect(result.approval?.mutation).toMatchObject({ diffRef: expect.any(String), changeFingerprint: expect.any(String) });
    expect(result.execution?.invocation).toMatchObject({
      input: { path: "existing.txt", diffRef: expect.any(String) },
      mutationSummary: { path: "existing.txt" },
    });
    await expect(readFile(join(root, "existing.txt"), "utf8")).resolves.toBe("sensitive-new-content\n");
    expect(events.map((event) => event.eventType)).toEqual([
      "tool.prepare.start",
      "tool.prepare.end",
      "policy.decision",
      "approval.matched",
      "tool.execution_allowed",
      "tool.call.start",
      "tool.commit.start",
      "tool.call.end",
      "tool.commit.end",
    ]);
    expect(JSON.stringify(events)).not.toContain("sensitive-new-content");
  });

  it("keeps files unchanged for policy denial, missing approval, explicit denial, and Abort", async () => {
    const scenarios = [
      { name: "policy", policy: denyPolicy(), approvalHandler: undefined },
      { name: "missing", policy: askPolicy(), approvalHandler: undefined },
      { name: "timeout", policy: askPolicy(), approvalHandler: async () => undefined },
      { name: "denied", policy: askPolicy(), approvalHandler: async () => ({ decision: "deny" as const }) },
    ];
    for (const scenario of scenarios) {
      const root = await workspace();
      const tool = await loadTool(root, "edit");
      const result = await runLifecycle(tool, {
        input: { path: "existing.txt", content: `${scenario.name}\n` },
        policy: scenario.policy,
        ...(scenario.approvalHandler ? { approvalHandler: scenario.approvalHandler } : {}),
      });
      expect(result.toolResult.isError).toBe(true);
      await expect(readFile(join(root, "existing.txt"), "utf8")).resolves.toBe("baseline\n");
    }

    const abortRoot = await workspace();
    const abortTool = await loadTool(abortRoot, "edit");
    const controller = new AbortController();
    const aborted = await runLifecycle(abortTool, {
      input: { path: "existing.txt", content: "aborted\n" },
      context: context("session-1", "principal-a", controller.signal),
      approvalHandler: async () => {
        controller.abort();
        return { decision: "allow" as const };
      },
    });
    expect(aborted.execution?.terminationReason).toBe("aborted");
    await expect(readFile(join(abortRoot, "existing.txt"), "utf8")).resolves.toBe("baseline\n");
  });

  it("reuses session approval only for the same principal, session, baseline, and target", async () => {
    const root = await workspace();
    let replaceAttempts = 0;
    const tool = await loadTool(root, "edit", async (temporaryPath, targetPath) => {
      replaceAttempts += 1;
      if (replaceAttempts === 1) throw new Error("first commit failed");
      await rename(temporaryPath, targetPath);
    });
    const approvalStore = new InMemoryApprovalStore();
    const approvalHandler = vi.fn(async () => ({ decision: "allow" as const, scope: "session" as const }));
    const input = { path: "existing.txt", content: "target\n" };

    const failed = await runLifecycle(tool, { input, approvalStore, approvalHandler });
    expect(failed.toolResult.isError).toBe(true);
    const retried = await runLifecycle(tool, { input, approvalStore, approvalHandler });
    expect(retried.toolResult.isError).not.toBe(true);
    expect(approvalHandler).toHaveBeenCalledOnce();

    await writeFile(join(root, "existing.txt"), "baseline\n", "utf8");
    const otherPrincipal = await runLifecycle(tool, {
      input,
      approvalStore,
      context: context("session-1", "principal-b"),
    });
    expect(otherPrincipal.outcome).toBe("approval_missing");
    const otherSession = await runLifecycle(tool, {
      input,
      approvalStore,
      context: context("session-2", "principal-a"),
    });
    expect(otherSession.outcome).toBe("approval_missing");
    await expect(readFile(join(root, "existing.txt"), "utf8")).resolves.toBe("baseline\n");

    const onceRoot = await workspace();
    const onceTool = await loadTool(onceRoot, "edit", async () => {
      throw new Error("leave baseline unchanged");
    });
    const onceHandler = vi.fn(async () => ({ decision: "allow" as const, scope: "once" as const }));
    await runLifecycle(onceTool, { input, approvalHandler: onceHandler });
    await runLifecycle(onceTool, { input, approvalHandler: onceHandler });
    expect(onceHandler).toHaveBeenCalledTimes(2);
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mingxu-r6-lifecycle-"));
  roots.push(root);
  await writeFile(join(root, "existing.txt"), "baseline\n", "utf8");
  return root;
}

async function loadTool(
  root: string,
  name: "write" | "edit",
  atomicReplace?: (temporaryPath: string, targetPath: string) => Promise<void>,
): Promise<Tool> {
  let selected: Tool | undefined;
  const plugin = createCodingToolsPlugin({ workspaceRoot: root, ...(atomicReplace ? { atomicReplace } : {}) });
  await plugin.setup({
    registerTool(tool) {
      if (tool.name === name) selected = tool as Tool;
    },
  });
  return selected!;
}

async function runLifecycle(tool: Tool, options: {
  input: unknown;
  policy?: PolicyEngine;
  approvalStore?: InMemoryApprovalStore;
  approvalHandler?: (prompt: never) => unknown;
  context?: RunContext;
  events?: RuntimeEvent[];
}) {
  const registry = new ToolRegistry([tool]);
  return executeToolLifecycle({
    name: tool.name,
    input: options.input,
    toolCallId: "tool-call-1",
    context: options.context ?? context("session-1", "principal-a"),
  }, {
    registry,
    executor: new ToolExecutor(registry),
    policy: options.policy ?? askPolicy(),
    approvalStore: options.approvalStore ?? new InMemoryApprovalStore(),
    ...(options.approvalHandler ? { approvalHandler: options.approvalHandler as never } : {}),
    eventSink: options.events ? { emit: async (event) => { options.events!.push(event); } } : undefined,
    audit: undefined,
    principalId: options.context?.principal ?? "principal-a",
    interactive: true,
  });
}

function context(sessionId: string, principal: string, signal?: AbortSignal): RunContext {
  return {
    runId: "run-1",
    sessionId,
    turnId: "run-1:turn:1",
    traceId: "trace-1",
    schemaVersion: "test",
    sequence: 1,
    startedAt: "2026-08-01T00:00:00.000Z",
    principal,
    ...(signal ? { signal } : {}),
  };
}

function askPolicy(): PolicyEngine {
  return { evaluate: async () => ({ effect: "ask", reason: "review mutation", ruleVersion: "r6" }) };
}

function denyPolicy(): PolicyEngine {
  return { evaluate: async () => ({ effect: "deny", reason: "blocked mutation", ruleVersion: "r6" }) };
}
