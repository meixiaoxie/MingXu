import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileSessionStore, SessionConflictError } from "../src/session/index.js";

describe("versioned session store", () => {
  it("creates, saves, lists, and archives session documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-session-v1-"));
    const store = new FileSessionStore(root);

    try {
      const created = await store.createSession({ title: "demo" });
      const saved = await store.saveSession(created, created.revision);
      const loaded = await store.getRequiredSession(saved.document.session.sessionId);
      const recent = await store.listRecentSessions();
      const archived = await store.archiveSession(saved.document.session.sessionId, loaded.revision);
      const deleted = await store.deleteSession(saved.document.session.sessionId, archived.revision);

      expect(loaded.schemaVersion).toBe("session/v1");
      expect(recent[0]).toMatchObject({
        sessionId: saved.document.session.sessionId,
        state: "active",
      });
      expect(archived.document.session.state).toBe("archived");
      expect(deleted.document.session.state).toBe("deleted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects stale writes using revision conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-session-v1-"));
    const store = new FileSessionStore(root);

    try {
      const created = await store.createSession();
      const firstSave = await store.saveSession(created, created.revision);
      await expect(store.saveSession(created, created.revision)).rejects.toBeInstanceOf(SessionConflictError);
      expect(firstSave.revision).toBeGreaterThan(created.revision);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers interrupted runs and migrates legacy messages files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-session-v1-"));
    const store = new FileSessionStore(root);
    const legacyPath = join(root, "legacy.json");
    const interruptedPath = join(root, "interrupted.json");

    try {
      await writeFile(legacyPath, JSON.stringify({ messages: [{ role: "user", content: "hello" }] }, null, 2), "utf8");
      const legacy = await store.getSession("legacy");
      expect(legacy?.schemaVersion).toBe("session/v1");
      expect(legacy?.runs[0]?.turns[0]?.messages[0]).toMatchObject({ role: "user", content: "hello" });

      await writeFile(interruptedPath, JSON.stringify({
        schemaVersion: "session/v1",
        revision: 1,
        updatedAt: new Date().toISOString(),
        session: {
          sessionId: "interrupted",
          state: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastRunId: "run-1",
        },
        runs: [{
          schemaVersion: "session/v1",
          runId: "run-1",
          sessionId: "interrupted",
          traceId: "trace-1",
          state: "running",
          startedAt: new Date().toISOString(),
          resolvedModel: "demo",
          configHash: "demo",
          pluginNames: [],
          policyVersion: "demo",
          turns: [],
        }],
        approvals: [],
      }, null, 2), "utf8");

      const recovered = await store.recoverInterruptedRuns();
      const recoveredDocument = JSON.parse(await readFile(interruptedPath, "utf8")) as { runs: Array<{ state: string; interruptedAt?: string }> };
      expect(recovered).toBe(1);
      expect(recoveredDocument.runs[0]?.state).toBe("interrupted");
      expect(recoveredDocument.runs[0]?.interruptedAt).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
