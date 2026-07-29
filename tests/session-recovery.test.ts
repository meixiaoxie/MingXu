import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { JsonlSessionStore, SessionRuntime } from "../src/session/index.js";
import type { Run, Turn } from "../src/index.js";

describe("session runtime recovery", () => {
  it("loads existing messages and persists run/turn updates into JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-session-runtime-"));
    const store = new JsonlSessionStore(root);
    const runtime = new SessionRuntime({ sessionStore: store, title: "demo" });

    try {
      const snapshot = await runtime.load();
      expect(snapshot.messages).toEqual([]);

      const recent = await store.listRecentSessions();
      const sessionId = recent[0]?.sessionId;
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

      const transcriptText = await readFile(join(root, `${sessionId}.jsonl`), "utf8");
      const transcript = JSON.parse(transcriptText.split("\n")[0] ?? "{}");
      expect(transcript.session.sessionId).toBe(sessionId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bootstraps legacy session documents into JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-session-runtime-legacy-"));
    const legacyId = "legacy-session";
    const legacyPath = join(root, `${legacyId}.json`);
    const store = new JsonlSessionStore(root);

    try {
      await writeFile(legacyPath, JSON.stringify({
        schemaVersion: "session/v1",
        revision: 1,
        updatedAt: "2026-07-28T00:00:00.000Z",
        session: {
          sessionId: legacyId,
          state: "active",
          createdAt: "2026-07-28T00:00:00.000Z",
          updatedAt: "2026-07-28T00:00:00.000Z",
        },
        runs: [],
        approvals: [],
      }, null, 2), "utf8");

      const document = await store.getRequiredSession(legacyId);
      expect(document.session.sessionId).toBe(legacyId);

      const transcript = await readFile(join(root, `${legacyId}.jsonl`), "utf8");
      expect(transcript).toContain(legacyId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects session identifiers that escape the session directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-session-runtime-safe-"));
    const store = new JsonlSessionStore(join(root, "sessions"));

    try {
      expect(() => store.createSession({ sessionId: "../escaped" })).toThrow(
        "Session ID is not a safe storage key",
      );
      await expect(readFile(join(root, "escaped.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects reserved session IDs and symbolic-link transcript targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-session-target-safe-"));
    const sessionRoot = join(root, "sessions");
    const outside = join(root, "outside");
    const sentinel = join(outside, "sentinel.jsonl");
    const store = new JsonlSessionStore(sessionRoot);

    try {
      expect(() => store.createSession({ sessionId: "NUL" })).toThrow("Session ID is not a safe storage key");
      await mkdir(sessionRoot, { recursive: true });
      await mkdir(outside);
      await writeFile(sentinel, "sentinel", "utf8");
      await symlink(outside, join(sessionRoot, "linked.jsonl"), process.platform === "win32" ? "junction" : "dir");
      const document = await store.createSession({ sessionId: "linked" });
      await expect(store.saveSession(document, 0)).rejects.toThrow("Storage target cannot be a symbolic link");
      expect(await readFile(sentinel, "utf8")).toBe("sentinel");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
