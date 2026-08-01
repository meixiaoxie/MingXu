import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createCodingToolsPlugin } from "../packages/coding-tools/runtime.js";
import { runAgentLoop } from "../src/core/agent-loop.js";
import type { Tool } from "../src/core/types.js";
import type { PolicyEngine } from "../src/policy/types.js";
import { JsonlSessionStore } from "../src/session/jsonl-session-store.js";

describe("R6 coding-tools Session summaries", () => {
  it("persists approval, Diff reference, and result without write content", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-r6-session-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions");
    const secretContent = "r6-sensitive-target-content";
    const tools: Tool[] = [];
    const plugin = createCodingToolsPlugin({ workspaceRoot: workspace });
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace, { recursive: true }));
    await plugin.setup({ registerTool: (tool) => tools.push(tool as Tool) });
    let modelCalls = 0;

    try {
      const result = await runAgentLoop("create a file", {
        model: {
          async generate() {
            modelCalls += 1;
            return modelCalls === 1
              ? { content: "", toolCalls: [{ id: "write-1", name: "write", input: { path: "result.txt", content: secretContent } }] }
              : { content: "created", toolCalls: [] };
          },
        },
        tools,
        policy: askPolicy(),
        approvalHandler: async () => ({ decision: "allow", scope: "once" }),
        interactive: true,
        principalId: "principal-a",
        sessionStore: new JsonlSessionStore(sessions),
      });

      expect(result.terminationReason).toBe("completed");
      expect(result.sessionId).toBeTruthy();
      await expect(readFile(join(workspace, "result.txt"), "utf8")).resolves.toBe(secretContent);
      const store = new JsonlSessionStore(sessions);
      const document = await store.getRequiredSession(result.sessionId!);
      expect(document.approvals).toHaveLength(1);
      expect(document.approvals[0]).toMatchObject({
        state: "approved",
        record: { mutation: { diffRef: expect.any(String), changeFingerprint: expect.any(String) } },
      });
      const invocation = document.runs.at(-1)?.turns.at(-1)?.toolInvocations[0];
      expect(invocation).toMatchObject({
        state: "completed",
        input: { path: "result.txt", diffRef: expect.any(String) },
        mutationSummary: { path: "result.txt", diffRef: expect.any(String) },
        output: { committed: true, diffRef: expect.any(String) },
      });
      expect(JSON.stringify(document)).not.toContain(secretContent);
      expect(await readFile(join(sessions, `${result.sessionId}.jsonl`), "utf8")).not.toContain(secretContent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists only a bounded mutation summary when prepare fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-r6-session-failure-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions");
    const secretContent = "r6-failed-prepare-sensitive-content";
    const tools: Tool[] = [];
    const plugin = createCodingToolsPlugin({ workspaceRoot: workspace });
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace, { recursive: true }));
    await plugin.setup({ registerTool: (tool) => tools.push(tool as Tool) });
    let modelCalls = 0;

    try {
      const result = await runAgentLoop("edit a missing file", {
        model: {
          async generate() {
            modelCalls += 1;
            return modelCalls === 1
              ? { content: "", toolCalls: [{ id: "edit-1", name: "edit", input: { path: "missing.txt", content: secretContent } }] }
              : { content: "not changed", toolCalls: [] };
          },
        },
        tools,
        policy: askPolicy(),
        approvalHandler: async () => ({ decision: "allow", scope: "once" }),
        interactive: true,
        principalId: "principal-a",
        sessionStore: new JsonlSessionStore(sessions),
      });

      const store = new JsonlSessionStore(sessions);
      const document = await store.getRequiredSession(result.sessionId!);
      expect(document.runs.at(-1)?.turns.at(-1)?.toolInvocations[0]?.input).toEqual({
        operation: "edit",
        path: "missing.txt",
        status: "prepare_failed",
      });
      expect(JSON.stringify(document)).not.toContain(secretContent);
      expect(await readFile(join(sessions, `${result.sessionId}.jsonl`), "utf8")).not.toContain(secretContent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function askPolicy(): PolicyEngine {
  return { evaluate: async () => ({ effect: "ask", reason: "review mutation", ruleVersion: "r6" }) };
}
