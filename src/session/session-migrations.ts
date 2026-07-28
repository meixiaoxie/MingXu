import { randomUUID } from "node:crypto";

import type { Message } from "../core/types.js";
import { redactValue } from "../redaction/redactor.js";
import { MigrationRegistry, type Migration } from "./migration-registry.js";
import { SESSION_SCHEMA_VERSION } from "./schema-version.js";
import type { SessionDocument, SessionRunRecord } from "./types.js";

interface LegacyMessagesDocument {
  messages?: Message[];
}

const legacyToV1: Migration<SessionDocument> = {
  from: "legacy/messages",
  to: SESSION_SCHEMA_VERSION,
  migrate(input: unknown): SessionDocument {
    const source = (input ?? {}) as LegacyMessagesDocument;
    const messages = Array.isArray(source.messages) ? source.messages.map((message) => redactValue(message) as Message) : [];
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const runId = randomUUID();
    const run: SessionRunRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      runId,
      sessionId,
      traceId: `trace-${runId}`,
      state: "succeeded",
      startedAt: now,
      endedAt: now,
      resolvedModel: "legacy",
      configHash: "legacy",
      pluginNames: [],
      policyVersion: "legacy",
      turns: messages.length === 0 ? [] : [{
        schemaVersion: SESSION_SCHEMA_VERSION,
        turnId: `${runId}:turn:1`,
        runId,
        state: "completed",
        sequence: 1,
        startedAt: now,
        endedAt: now,
        messages,
        toolInvocations: [],
      }],
    };

    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      revision: 1,
      updatedAt: now,
      session: {
        sessionId,
        state: "active",
        createdAt: now,
        updatedAt: now,
        lastRunId: runId,
      },
      runs: [run],
      approvals: [],
    };
  },
};

export const sessionMigrationRegistry = new MigrationRegistry<SessionDocument>([
  legacyToV1,
]);

export function migrateLegacySessionDocument(input: unknown): SessionDocument {
  return sessionMigrationRegistry.migrate("legacy/messages", input);
}
