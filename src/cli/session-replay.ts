import { inspect } from "node:util";

import { sanitizeTerminalText } from "@mingxu/tui";
import type { Message, ToolCall } from "../core/types.js";
import { redactValue } from "../redaction/redactor.js";
import type {
  SessionDocument,
  SessionExtensionSnapshot,
  SessionPresentationBlock,
} from "../session/types.js";

export interface SessionReplayResult {
  readonly blocks: readonly SessionPresentationBlock[];
  readonly diagnostics: readonly string[];
  readonly extensionSnapshot?: SessionExtensionSnapshot;
}

export function buildSessionReplay(document: SessionDocument): SessionReplayResult {
  const diagnostics: string[] = [];
  const persisted = normalizePersistedBlocks(document.presentationBlocks, diagnostics);
  const blocks = persisted.length > 0 ? persisted : rebuildBlocks(document, diagnostics);
  const extensionSnapshot = normalizeExtensionSnapshot(document, diagnostics);
  return {
    blocks,
    diagnostics,
    ...(extensionSnapshot !== undefined ? { extensionSnapshot } : {}),
  };
}

function normalizePersistedBlocks(
  source: readonly SessionPresentationBlock[] | undefined,
  diagnostics: string[],
): SessionPresentationBlock[] {
  if (!Array.isArray(source)) return [];
  const order: string[] = [];
  const byId = new Map<string, SessionPresentationBlock>();
  source.forEach((candidate, index) => {
    if (!isPresentationBlock(candidate)) {
      diagnostics.push(`Skipped damaged presentation block at index ${index}.`);
      return;
    }
    const previous = byId.get(candidate.id);
    if (!previous) order.push(candidate.id);
    if (!previous || candidate.revision > previous.revision) byId.set(candidate.id, candidate);
  });
  return order.flatMap((id) => {
    const block = byId.get(id);
    return block ? [block] : [];
  });
}

function rebuildBlocks(document: SessionDocument, diagnostics: string[]): SessionPresentationBlock[] {
  const turn = [...document.runs].reverse().flatMap((run) => [...run.turns].reverse()).find((candidate) => Array.isArray(candidate.messages));
  if (!turn) {
    if (document.runs.length > 0) diagnostics.push("Session contains runs but no recoverable message snapshot.");
    return [];
  }
  const calls = new Map<string, ToolCall>();
  const blocks: SessionPresentationBlock[] = [];
  turn.messages.forEach((message, index) => {
    if (!isMessage(message)) {
      diagnostics.push(`Skipped damaged message at index ${index}.`);
      return;
    }
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) calls.set(call.id, call);
      if (!message.content) return;
    }
    if (message.role === "tool") {
      const call = calls.get(message.toolResult.toolCallId);
      blocks.push({
        id: `replay:${document.session.sessionId}:tool:${message.toolResult.toolCallId}`,
        revision: 1,
        kind: "tool",
        title: sanitizeTerminalText(message.toolResult.name),
        state: message.toolResult.isError ? "error" : "complete",
        summary: message.toolResult.isError ? "error" : "done",
        lines: [
          `input: ${describeValue(call?.input ?? "unavailable")}`,
          `output: ${describeValue(message.toolResult.output)}`,
          `status: ${message.toolResult.isError ? "error" : "done"}`,
        ],
        live: false,
        source: "session-replay",
      });
      return;
    }
    blocks.push({
      id: `replay:${document.session.sessionId}:message:${index}`,
      revision: 1,
      kind: message.role,
      title: message.role === "user" ? "you" : "MingXu",
      state: "complete",
      summary: sanitizeTerminalText(message.content),
      lines: sanitizeTerminalText(message.content).split("\n"),
      live: false,
      source: "session-replay",
    });
  });
  for (const approval of document.approvals) {
    if (!approval?.record?.id) {
      diagnostics.push("Skipped damaged approval summary.");
      continue;
    }
    blocks.push({
      id: `replay:${document.session.sessionId}:approval:${approval.approvalId}`,
      revision: 1,
      kind: "approval-result",
      title: `${sanitizeTerminalText(approval.record.operator)} approval`,
      state: approval.state === "denied" ? "error" : "complete",
      summary: approval.record.decision,
      lines: [
        `decision: ${approval.record.decision}`,
        `principal: ${sanitizeTerminalText(approval.record.principalId)}`,
        `action: ${sanitizeTerminalText(approval.record.actionKind)}`,
        `resource: ${sanitizeTerminalText(approval.record.resourceScope)}`,
      ],
      live: false,
      source: "session-replay",
    });
  }
  return blocks;
}

function normalizeExtensionSnapshot(document: SessionDocument, diagnostics: string[]): SessionExtensionSnapshot | undefined {
  if (document.extensionSnapshot !== undefined) {
    if (typeof document.extensionSnapshot.capturedAt === "string" && Array.isArray(document.extensionSnapshot.extensions)) {
      return document.extensionSnapshot;
    }
    diagnostics.push("Ignored damaged extension snapshot.");
  }
  const latestRun = document.runs.at(-1);
  if (!latestRun || latestRun.pluginNames.length === 0) return undefined;
  return {
    capturedAt: latestRun.endedAt ?? latestRun.startedAt,
    extensions: latestRun.pluginNames.map((id) => ({ id, version: "unknown", enabled: true, health: "recorded" })),
  };
}

function isPresentationBlock(value: unknown): value is SessionPresentationBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Partial<SessionPresentationBlock>;
  return typeof block.id === "string"
    && Number.isInteger(block.revision) && (block.revision ?? 0) > 0
    && typeof block.kind === "string"
    && typeof block.title === "string"
    && typeof block.state === "string"
    && typeof block.summary === "string"
    && Array.isArray(block.lines) && block.lines.every((line) => typeof line === "string");
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<Message>;
  if (typeof message.role !== "string" || typeof message.content !== "string") return false;
  if (message.role === "tool") {
    return "toolResult" in message && typeof message.toolResult?.toolCallId === "string" && typeof message.toolResult.name === "string";
  }
  return message.role === "user" || message.role === "assistant";
}

function describeValue(value: unknown): string {
  try {
    return sanitizeTerminalText(inspect(redactValue(value), { depth: 4, breakLength: 100 }));
  } catch {
    return sanitizeTerminalText(String(value));
  }
}
