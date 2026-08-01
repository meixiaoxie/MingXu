import { randomUUID } from "node:crypto";

import type { ApprovalRecord } from "../approval/types.js";
import type { Message, Run, Turn, ToolInvocation } from "../core/types.js";
import { redactText, redactValue } from "../redaction/redactor.js";
import { SESSION_SCHEMA_VERSION } from "./schema-version.js";
import type {
  SessionApprovalRecord,
  SessionDocument,
  SessionRunRecord,
  SessionRuntimeSnapshot,
  SessionToolInvocationRecord,
  SessionTurnRecord,
} from "./types.js";
import type { SessionStore } from "./session-store.js";

export interface SessionRuntimeOptions {
  readonly sessionStore: SessionStore;
  readonly sessionId?: string;
  readonly title?: string;
}

function redactMessages(messages: Message[], invocations: readonly ToolInvocation[] = []): Message[] {
  const invocationInputs = new Map(invocations.map((invocation) => [
    invocation.toolCallId,
    invocation.mutationSummary ?? invocation.input,
  ] as const));
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        ...message,
        content: redactText(message.content),
        ...(message.toolCalls ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            input: redactValue(invocationInputs.get(call.id) ?? call.input),
          })),
        } : {}),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        content: redactText(JSON.stringify(redactValue(message.toolResult.output))),
        toolResult: {
          ...message.toolResult,
          output: redactValue(message.toolResult.output),
          ...(message.toolResult.artifact !== undefined ? { artifact: message.toolResult.artifact } : {}),
          ...(message.toolResult.truncated !== undefined ? { truncated: message.toolResult.truncated } : {}),
          ...(message.toolResult.originalBytes !== undefined ? { originalBytes: message.toolResult.originalBytes } : {}),
        },
      };
    }
    return {
      ...message,
      content: redactText(message.content),
    };
  });
}

export class SessionRuntime {
  readonly #store: SessionStore;
  readonly #requestedSessionId?: string;
  readonly #title?: string;
  #document?: SessionDocument;
  #activeRunId?: string;

  constructor(options: SessionRuntimeOptions) {
    this.#store = options.sessionStore;
    if (options.sessionId !== undefined) {
      this.#requestedSessionId = options.sessionId;
    }
    if (options.title !== undefined) {
      this.#title = options.title;
    }
  }

  async load(): Promise<SessionRuntimeSnapshot> {
    if (this.#document) {
      return this.snapshot();
    }

    const document = this.#requestedSessionId
      ? await this.getRequiredSession(this.#requestedSessionId)
      : await this.#store.createSession({ ...(this.#title !== undefined ? { title: this.#title } : {}) });

    if (!this.#requestedSessionId) {
      const saved = await this.#store.saveSession(document, document.revision);
      this.#document = saved.document;
      return this.snapshot();
    }

    this.#document = document;
    return this.snapshot();
  }

  async beginRun(run: Run, firstUserMessage: Message): Promise<void> {
    const document = await this.ensureDocument();
    const sessionId = document.session.sessionId;
    this.#activeRunId = run.runId;
    const sessionRun: SessionRunRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      runId: run.runId,
      sessionId,
      traceId: run.traceId,
      state: "running",
      startedAt: run.startedAt,
      resolvedModel: run.resolvedModel,
      configHash: run.configHash,
      pluginNames: run.pluginNames,
      policyVersion: run.policyVersion,
      turns: [{
        schemaVersion: SESSION_SCHEMA_VERSION,
        turnId: `${run.runId}:turn:1`,
        runId: run.runId,
        state: "running",
        sequence: 1,
        startedAt: run.startedAt,
        messages: [firstUserMessage],
        toolInvocations: [],
      }],
    };

    const nextDocument: SessionDocument = {
      ...document,
      session: {
        ...document.session,
        updatedAt: run.startedAt,
        lastRunId: run.runId,
      },
      runs: [...document.runs, sessionRun],
    };
    const saved = await this.#store.saveSession(nextDocument, document.revision);
    this.#document = saved.document;
  }

  async appendAssistantAndTools(messages: Message[], turn: Turn): Promise<void> {
    const document = await this.ensureDocument();
    if (!this.#activeRunId) return;
    const nextRuns = document.runs.map((run) => {
      if (run.runId !== this.#activeRunId) return run;
      const latestTurn = run.turns.at(-1);
      const updatedTurn: SessionTurnRecord = latestTurn
        ? {
            ...latestTurn,
            state: turn.state,
            ...(turn.state === "completed" ? { endedAt: new Date().toISOString() } : {}),
            messages: redactMessages(messages, turn.toolInvocations),
            toolInvocations: turn.toolInvocations.map(toSessionToolInvocation),
          }
        : {
            schemaVersion: SESSION_SCHEMA_VERSION,
            turnId: turn.turnId,
            runId: turn.runId,
            state: turn.state,
            sequence: turn.sequence,
            startedAt: turn.startedAt,
            ...(turn.state === "completed" ? { endedAt: new Date().toISOString() } : {}),
            messages: redactMessages(messages, turn.toolInvocations),
            toolInvocations: turn.toolInvocations.map(toSessionToolInvocation),
          };
      const turns = latestTurn
        ? [...run.turns.slice(0, -1), updatedTurn]
        : [updatedTurn];
      return {
        ...run,
        turns,
      };
    });

    const saved = await this.#store.saveSession({
      ...document,
      runs: nextRuns,
    }, document.revision);
    this.#document = saved.document;
  }

  async finishRun(runId: string, messages: Message[], turn: Turn, options: {
    state: SessionRunRecord["state"];
    terminationReason?: SessionRunRecord["terminationReason"];
    usage?: SessionRunRecord["usage"];
  }): Promise<void> {
    const document = await this.ensureDocument();
    const now = new Date().toISOString();
    const nextRuns = document.runs.map((run) => {
      if (run.runId !== runId) return run;
      const latestTurn = run.turns.at(-1);
      const updatedTurn: SessionTurnRecord = latestTurn
        ? {
            ...latestTurn,
            state: turn.state,
            endedAt: now,
            messages: redactMessages(messages, turn.toolInvocations),
            toolInvocations: turn.toolInvocations.map(toSessionToolInvocation),
          }
        : {
            schemaVersion: SESSION_SCHEMA_VERSION,
            turnId: turn.turnId,
            runId: turn.runId,
            state: turn.state,
            sequence: turn.sequence,
            startedAt: turn.startedAt,
            endedAt: now,
            messages: redactMessages(messages, turn.toolInvocations),
            toolInvocations: turn.toolInvocations.map(toSessionToolInvocation),
          };
      const turns = latestTurn
        ? [...run.turns.slice(0, -1), updatedTurn]
        : [updatedTurn];
      return {
        ...run,
        state: options.state,
        endedAt: now,
        ...(options.state === "interrupted" ? { interruptedAt: now } : {}),
        ...(options.terminationReason !== undefined ? { terminationReason: options.terminationReason } : {}),
        ...(options.usage !== undefined ? { usage: options.usage } : {}),
        turns,
      };
    });

    const saved = await this.#store.saveSession({
      ...document,
      session: {
        ...document.session,
        updatedAt: now,
        lastRunId: runId,
      },
      runs: nextRuns,
    }, document.revision);
    this.#document = saved.document;
  }

  async recordApproval(record: ApprovalRecord, state: SessionApprovalRecord["state"], ids?: {
    runId?: string;
    turnId?: string;
  }): Promise<void> {
    const document = await this.ensureDocument();
    const approval: SessionApprovalRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      approvalId: record.id,
      ...(ids?.runId !== undefined ? { runId: ids.runId } : {}),
      ...(ids?.turnId !== undefined ? { turnId: ids.turnId } : {}),
      state,
      record,
    };

    const existingIndex = document.approvals.findIndex((candidate) => candidate.approvalId === record.id);
    const approvals = existingIndex >= 0
      ? document.approvals.map((candidate, index) => index === existingIndex ? approval : candidate)
      : [...document.approvals, approval];
    const saved = await this.#store.saveSession({
      ...document,
      approvals,
    }, document.revision);
    this.#document = saved.document;
  }

  snapshot(): SessionRuntimeSnapshot {
    const document = this.#document;
    if (!document) {
      return { messages: [] };
    }
    const latestRun = document.runs.at(-1);
    const latestTurn = latestRun?.turns.at(-1);
    return {
      messages: latestTurn?.messages ?? [],
      ...(latestRun !== undefined ? { latestRun } : {}),
      ...(latestTurn !== undefined ? { latestTurn } : {}),
    };
  }

  currentSessionId(): string | undefined {
    return this.#document?.session.sessionId;
  }

  private async ensureDocument(): Promise<SessionDocument> {
    if (this.#document) {
      const latest = await this.#store.getSession(this.#document.session.sessionId);
      if (latest && latest.revision > this.#document.revision) {
        this.#document = latest;
      }
      return this.#document;
    }
    const created = await this.#store.createSession({
      ...(this.#requestedSessionId !== undefined ? { sessionId: this.#requestedSessionId } : {}),
      ...(this.#title !== undefined ? { title: this.#title } : {}),
    });
    this.#document = created;
    return created;
  }

  private async getRequiredSession(sessionId: string): Promise<SessionDocument> {
    if (typeof this.#store.getRequiredSession === "function") {
      return this.#store.getRequiredSession(sessionId);
    }
    const document = await this.#store.getSession(sessionId);
    if (!document) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return document;
  }
}

function toSessionToolInvocation(invocation: ToolInvocation): SessionToolInvocationRecord {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    invocationId: invocation.invocationId,
    toolCallId: invocation.toolCallId,
    toolName: invocation.toolName,
    state: invocation.state,
    startedAt: new Date().toISOString(),
    ...(invocation.state === "completed" || invocation.state === "failed" ? { endedAt: new Date().toISOString() } : {}),
    input: redactValue(invocation.mutationSummary ?? invocation.input),
    ...(invocation.mutationSummary !== undefined ? { mutationSummary: invocation.mutationSummary } : {}),
    ...(invocation.output !== undefined ? { output: invocation.output } : {}),
    ...(invocation.isError !== undefined ? { isError: invocation.isError } : {}),
  };
}
