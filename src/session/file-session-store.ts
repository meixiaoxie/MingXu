import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { migrateLegacySessionDocument } from "./session-migrations.js";
import { SESSION_SCHEMA_VERSION } from "./schema-version.js";
import type { SessionStore } from "./session-store.js";
import type { SessionDocument, SessionSummary, SessionWriteResult } from "./types.js";

export class SessionConflictError extends Error {}

export class FileSessionStore implements SessionStore {
  readonly #directory: string;
  #operation: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    if (!directory.trim()) {
      throw new Error("Session directory cannot be empty");
    }
    this.#directory = resolve(directory);
  }

  async createSession(input: { sessionId?: string; title?: string } = {}): Promise<SessionDocument> {
    const sessionId = input.sessionId ?? randomUUID();
    const now = new Date().toISOString();
    return {
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
    };
  }

  async getSession(sessionId: string): Promise<SessionDocument | undefined> {
    const filePath = this.#getSessionPath(sessionId);
    return this.#run(async () => this.#readSessionFile(filePath));
  }

  async saveSession(document: SessionDocument, expectedRevision?: number): Promise<SessionWriteResult> {
    const filePath = this.#getSessionPath(document.session.sessionId);
    return this.#run(async () => {
      const current = await this.#readSessionFile(filePath);
      if (current && expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new SessionConflictError(`Session revision conflict for ${document.session.sessionId}`);
      }
      const nextRevision = (current?.revision ?? 0) + 1;
      const nextDocument: SessionDocument = {
        ...document,
        schemaVersion: SESSION_SCHEMA_VERSION,
        revision: nextRevision,
        updatedAt: new Date().toISOString(),
        session: {
          ...document.session,
          updatedAt: new Date().toISOString(),
        },
      };
      await this.#writeSessionFile(filePath, nextDocument);
      return {
        document: nextDocument,
        revision: nextRevision,
      };
    });
  }

  async listRecentSessions(limit = 20): Promise<SessionSummary[]> {
    return this.#run(async () => {
      await mkdir(this.#directory, { recursive: true });
      const entries = (await readdir(this.#directory))
        .filter((entry) => entry.endsWith(".json"))
        .sort();
      const documents = await Promise.all(entries.map((entry) => this.#readSessionFile(join(this.#directory, entry))));
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
    return this.saveSession({
      ...existing,
      session: {
        ...existing.session,
        state: "archived",
      },
    }, expectedRevision ?? existing.revision);
  }

  async deleteSession(sessionId: string, expectedRevision?: number): Promise<SessionWriteResult> {
    const existing = await this.getRequiredSession(sessionId);
    return this.saveSession({
      ...existing,
      session: {
        ...existing.session,
        state: "deleted",
      },
    }, expectedRevision ?? existing.revision);
  }

  async recoverInterruptedRuns(now = new Date().toISOString()): Promise<number> {
    return this.#run(async () => {
      await mkdir(this.#directory, { recursive: true });
      const entries = (await readdir(this.#directory)).filter((entry) => entry.endsWith(".json"));
      let recovered = 0;
      for (const entry of entries) {
        const filePath = join(this.#directory, entry);
        const document = await this.#readSessionFile(filePath);
        if (!document) continue;
        let changed = false;
        const runs = document.runs.map((run) => {
          if (run.state === "running" || run.state === "pending") {
            changed = true;
            return {
              ...run,
              state: "interrupted" as const,
              interruptedAt: now,
              ...(run.endedAt === undefined ? { endedAt: now } : {}),
            };
          }
          return run;
        });
        if (changed) {
          recovered += 1;
          await this.#writeSessionFile(filePath, {
            ...document,
            revision: document.revision + 1,
            updatedAt: now,
            runs,
            session: {
              ...document.session,
              updatedAt: now,
            },
          });
        }
      }
      return recovered;
    });
  }

  async getRequiredSession(sessionId: string): Promise<SessionDocument> {
    const document = await this.getSession(sessionId);
    if (!document) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return document;
  }

  #getSessionPath(sessionId: string): string {
    return join(this.#directory, `${sessionId}.json`);
  }

  async #readSessionFile(filePath: string): Promise<SessionDocument | undefined> {
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
      throw new Error(`Failed to read session file: ${filePath}`, { cause: error });
    }
  }

  async #writeSessionFile(filePath: string, document: SessionDocument): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw new Error(`Failed to write session file: ${filePath}`, { cause: error });
    }
  }

  async #run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
