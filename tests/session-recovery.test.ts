import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FileSessionStore, SessionRuntime } from "../src/session/index.js";
import type { Run, Turn } from "../src/index.js";

describe("session runtime recovery", () => {
  it("loads existing messages and persists run/turn updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-session-runtime-"));
    const store = new FileSessionStore(root);
    const runtime = new SessionRuntime({ sessionStore: store, title: "demo" });

    try {
      const snapshot = await runtime.load();
      expect(snapshot.messages).toEqual([]);

      const initialDocument = await store.listRecentSessions();
      const sessionId = initialDocument[0]?.sessionId;
      expect(sessionId).toBeTruthy();

      const run: Run = {
        runId: "run-1",
        ...(sessionId !== undefined ? { sessionId } : {}),
        traceId: "trace-1",
        state: "pending",
        resolvedModel: "demo",
        configHash: "config",
        pluginNames: [],
        policyVersion: "policy-v1",
        schemaVersion: "session/v1",
        startedAt: new Date().toISOString(),
        turns: [],
      };
      await runtime.beginRun(run, { role: "user", content: "hello" });

      const turn: Turn = {
        turnId: "run-1:turn:1",
        runId: "run-1",
        state: "completed",
        sequence: 1,
        startedAt: new Date().toISOString(),
        toolInvocations: [],
      };
      await runtime.appendAssistantAndTools([
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ], turn);
      await runtime.finishRun("run-1", [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ], turn, {
        state: "succeeded",
        terminationReason: "completed",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          modelRequests: 1,
        },
      });

      const document = await store.getRequiredSession(sessionId!);
      expect(document.runs[0]?.state).toBe("succeeded");
      expect(document.runs[0]?.turns[0]?.messages.at(-1)).toMatchObject({ role: "assistant", content: "world" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
