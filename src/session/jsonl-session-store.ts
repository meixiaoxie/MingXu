import { randomUUID } from "node:crypto";
import { appendFile, access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ApprovalRecord } from "../approval/types.js";
import type { Message, Run, RunTerminationReason, ToolResult, Turn } from "../core/types.js";
import { migrateLegacySessionDocument } from "./session-migrations.js";
import type { SessionEntry } from "./session-entry.js";
import { SESSION_SCHEMA_VERSION } from "./schema-version.js";
import type {
  SessionDocument,
  SessionRecord,
  SessionRunRecord,
  SessionRuntimeSnapshot,
  SessionSummary,
  SessionToolInvocationRecord,
  SessionTurnRecord,
  SessionWriteResult,
} from "./types.js";
import type { SessionStore } from "./session-store.js";
import type { JsonlSessionStore as JsonlSessionStoreInterface } from "./jsonl-session-types.js";

interface JsonlSessionStoreOptions {
  readonly mode?: "file" | "directory";
}

/**
 * JSONL session store.
 *
 * In file mode it keeps the existing helper behavior used by the JSONL tests.
 * In directory mode it acts as the live session store and writes append-only
 * transcript snapshots to one JSONL file per session.
 */
export class JsonlSessionStore implements JsonlSessionStoreInterface, SessionStore {
  readonly #path: string;
  readonly #mode: "file" | "directory";
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string, options: JsonlSessionStoreOptions = {}) {
    if (!path.trim()) throw new Error("Session file path cannot be empty");
    this.#path = resolve(path);
    this.#mode = options.mode ?? (this.#path.endsWith(".jsonl") ? "file" : "directory");
  }

  // ------------------------------------------------------------
  // File-mode helper API used by existing JSONL tests
  // ------------------------------------------------------------

  async append(entry: SessionEntry): Promise<void> {
    this.#assertMode("file", "append");
    const line = `${JSON.stringify(entry)}\n`;
    this.#writeQueue = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await appendFile(this.#path, line, "utf8");
    });
    return this.#writeQueue;
  }

  async load(sessionId: string): Promise<SessionEntry[]> {
    this.#assertMode("file", "load");
    const text = await this.#readIfExists(this.#path);
    const entries: SessionEntry[] = [];

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const entry = JSON.parse(trimmed) as SessionEntry;
        if (entry.sessionId === sessionId) {
          entries.push(entry);
        }
      } catch {
        continue;
      }
    }

    return entries;
  }

  async getAncestorChain(entryId: string): Promise<SessionEntry[]> {
    this.#assertMode("file", "getAncestorChain");
    const allEntries = await this.#readAllEntries(this.#path);
    const byId = new Map(allEntries.map((entry) => [entry.id, entry] as const));
    const chain: SessionEntry[] = [];
    let current = byId.get(entryId);

    while (current) {
      chain.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }

    return chain;
  }

  async getChildren(parentId: string): Promise<SessionEntry[]> {
    this.#assertMode("file", "getChildren");
    const allEntries = await this.#readAllEntries(this.#path);
    return allEntries.filter((entry) => entry.parentId === parentId);
  }

  async getLeaves(sessionId: string): Promise<SessionEntry[]> {
    this.#assertMode("file", "getLeaves");
    const entries = await this.load(sessionId);
    return entries.filter((entry) => !entries.some((child) => child.parentId === entry.id));
  }

  async getLatestLeaf(sessionId: string): Promise<SessionEntry | undefined> {
    this.#assertMode("file", "getLatestLeaf");
    const entries = await this.load(sessionId);
    if (entries.length === 0) return undefined;

    const leaves = entries.filter((entry) => !entries.some((child) => child.parentId === entry.id));
    leaves.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return leaves[0];
  }

  async clear(_sessionId: string): Promise<void> {
    this.#assertMode("file", "clear");
    await writeFile(this.#path, "", "utf8");
  }

  // ------------------------------------------------------------
  // Live SessionStore API used by the app in directory mode
  // ------------------------------------------------------------

  createSession(input: { sessionId?: string; title?: string } = {}): Promise<SessionDocument> {
    const sessionId = input.sessionId ?? randomUUID();
    const now = new Date().toISOString();
    return Promise.resolve({
      schemaVersion: SESSION_SCHEMA_VERSION,
      revision: 0,
      updatedAt: now,
      session: {
        sessionId,
        state: "active",
        createdAt: now,
        updatedAt: now,
        ...(input.title !== undefined ? { title: input.title } : {}),
      },
      runs: [],
      approvals: [],
    });
  }

  async getSession(sessionId: string): Promise<SessionDocument | undefined> {
    return this.#run(async () => this.#readCurrentSessionDocument(sessionId, true));
  }

  async getRequiredSession(sessionId: string): Promise<SessionDocument> {
    const document = await this.getSession(sessionId);
    if (!document) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return document;
  }

  async saveSession(document: SessionDocument, expectedRevision?: number): Promise<SessionWriteResult> {
    return this.#run(async () => {
      this.#assertMode("directory", "saveSession");
      const current = await this.#readCurrentSessionDocument(document.session.sessionId, true);
      const currentRevision = current?.revision ?? 0;
      if (current !== undefined && expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new Error(`Session revision conflict for ${document.session.sessionId}`);
      }
      if (current === undefined && expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new Error(`Session revision conflict for ${document.session.sessionId}`);
      }

      const nextRevision = currentRevision + 1;
      const now = new Date().toISOString();
      const nextDocument: SessionDocument = {
        ...document,
        schemaVersion: SESSION_SCHEMA_VERSION,
        revision: nextRevision,
        updatedAt: now,
        session: {
          ...document.session,
          updatedAt: now,
        },
      };
      await this.#appendSessionSnapshot(nextDocument);
      return {
        document: nextDocument,
        revision: nextRevision,
      };
    });
  }

  async listRecentSessions(limit = 20): Promise<SessionSummary[]> {
    return this.#run(async () => {
      this.#assertMode("directory", "listRecentSessions");
      await mkdir(this.#path, { recursive: true });
      const sessionIds = await this.#discoverSessionIds();
      const documents = await Promise.all(
        sessionIds.map(async (sessionId) => this.#readCurrentSessionDocument(sessionId, false)),
      );
      return documents
        .filter((document): document is SessionDocument => document !== undefined)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, limit)
        .map((document) => {
          const lastRun = document.runs.at(-1);
          return {
            sessionId: document.session.sessionId,
            state: document.session.state,
            updatedAt: document.updatedAt,
            ...(document.session.lastRunId !== undefined ? { lastRunId: document.session.lastRunId } : {}),
            ...(lastRun !== undefined ? { lastRunState: lastRun.state } : {}),
            ...(document.session.title !== undefined ? { title: document.session.title } : {}),
          };
        });
    });
  }

  async archiveSession(sessionId: string, expectedRevision?: number): Promise<SessionWriteResult> {
    const existing = await this.getRequiredSession(sessionId);
    return this.saveSession(
      {
        ...existing,
        session: {
          ...existing.session,
          state: "archived",
        },
      },
      expectedRevision ?? existing.revision,
    );
  }

  async deleteSession(sessionId: string, expectedRevision?: number): Promise<SessionWriteResult> {
    const existing = await this.getRequiredSession(sessionId);
    return this.saveSession(
      {
        ...existing,
        session: {
          ...existing.session,
          state: "deleted",
        },
      },
      expectedRevision ?? existing.revision,
    );
  }

  async recoverInterruptedRuns(now = new Date().toISOString()): Promise<number> {
    return this.#run(async () => {
      this.#assertMode("directory", "recoverInterruptedRuns");
      await mkdir(this.#path, { recursive: true });
      const sessionIds = await this.#discoverSessionIds();
      let recovered = 0;

      for (const sessionId of sessionIds) {
        const document = await this.#readCurrentSessionDocument(sessionId, false);
        if (!document) continue;

        const interruptedRuns = document.runs.map((run) => {
          if (run.state === "running" || run.state === "pending") {
            return {
              ...run,
              state: "interrupted" as const,
              interruptedAt: now,
              ...(run.endedAt === undefined ? { endedAt: now } : {}),
            };
          }
          return run;
        });

        const changed = interruptedRuns.some((run, index) => run.state !== document.runs[index]?.state);
        if (!changed) continue;

        recovered += 1;
        await this.#appendSessionSnapshot({
          ...document,
          revision: document.revision + 1,
          updatedAt: now,
          session: {
            ...document.session,
            updatedAt: now,
          },
          runs: interruptedRuns,
        });
      }

      return recovered;
    });
  }

  // ------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------

  async #readCurrentSessionDocument(sessionId: string, bootstrapLegacy: boolean): Promise<SessionDocument | undefined> {
    const transcriptPath = this.#sessionTranscriptPath(sessionId);
    const current = await this.#readSessionDocumentFromJsonl(transcriptPath, sessionId);
    if (current !== undefined) {
      return current;
    }

    const legacyPath = this.#legacySessionPath(sessionId);
    const legacy = await this.#readLegacySessionDocument(legacyPath);
    if (legacy === undefined) {
      return undefined;
    }

    if (bootstrapLegacy) {
      await this.#appendSessionSnapshot(legacy);
    }
    return legacy;
  }

  async #readLegacySessionDocument(filePath: string): Promise<SessionDocument | undefined> {
    try {
      const source = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(source);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Session data must be a JSON object");
      }
      if ("schemaVersion" in parsed) {
        const document = parsed as Partial<SessionDocument>;
        if (document.schemaVersion !== SESSION_SCHEMA_VERSION) {
          throw new Error(`Unknown session schemaVersion: ${String(document.schemaVersion)}`);
        }
        return document as SessionDocument;
      }
      return migrateLegacySessionDocument(parsed);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new Error(`Failed to read legacy session file: ${filePath}`, { cause: error });
    }
  }

  async #readSessionDocumentFromJsonl(filePath: string, sessionId: string): Promise<SessionDocument | undefined> {
    const text = await this.#readIfExists(filePath);
    let lastDocument: SessionDocument | undefined;

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (this.#isSessionDocument(parsed, sessionId)) {
          lastDocument = parsed;
        }
      } catch {
        continue;
      }
    }

    return lastDocument;
  }

  async #appendSessionSnapshot(document: SessionDocument): Promise<void> {
    const transcriptPath = this.#sessionTranscriptPath(document.session.sessionId);
    await mkdir(dirname(transcriptPath), { recursive: true });
    await appendFile(transcriptPath, `${JSON.stringify(document)}\n`, "utf8");
  }

  async #discoverSessionIds(): Promise<string[]> {
    const entries = await readdir(this.#path, { withFileTypes: true });
    const sessionIds = new Set<string>();
    const jsonlIds = new Set<string>();

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".jsonl")) {
        const id = entry.name.slice(0, -".jsonl".length);
        sessionIds.add(id);
        jsonlIds.add(id);
      }
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!jsonlIds.has(id)) {
        sessionIds.add(id);
      }
    }

    return [...sessionIds];
  }

  #sessionTranscriptPath(sessionId: string): string {
    return join(this.#path, `${sessionId}.jsonl`);
  }

  #legacySessionPath(sessionId: string): string {
    return join(this.#path, `${sessionId}.json`);
  }

  #isSessionDocument(value: unknown, expectedSessionId?: string): value is SessionDocument {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const document = value as Partial<SessionDocument>;
    if (document.schemaVersion !== SESSION_SCHEMA_VERSION) return false;
    if (typeof document.revision !== "number") return false;
    if (!document.session || typeof document.session !== "object") return false;
    if (typeof document.session.sessionId !== "string") return false;
    if (expectedSessionId !== undefined && document.session.sessionId !== expectedSessionId) return false;
    if (!Array.isArray(document.runs) || !Array.isArray(document.approvals)) return false;
    return true;
  }

  #assertMode(expected: "file" | "directory", operation: string): void {
    if (this.#mode !== expected) {
      throw new Error(`JsonlSessionStore.${operation} is only available in ${expected} mode`);
    }
  }

  async #readIfExists(filePath: string): Promise<string> {
    try {
      await access(filePath);
      return await readFile(filePath, "utf8");
    } catch {
      return "";
    }
  }

  async #readAllEntries(filePath: string): Promise<SessionEntry[]> {
    const text = await this.#readIfExists(filePath);
    const entries: SessionEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch {
        continue;
      }
    }
    return entries;
  }

  async #run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.#writeQueue.then(operation, operation);
    this.#writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
