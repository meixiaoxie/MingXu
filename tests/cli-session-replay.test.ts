import { describe, expect, it } from "vitest";

import { CliRuntimeProjection } from "../src/cli/runtime-projection.js";
import { buildSessionReplay } from "../src/cli/session-replay.js";
import type { AgentEvent } from "../src/events/types.js";
import type { SessionDocument, SessionPresentationBlock } from "../src/session/types.js";

const now = "2026-07-31T00:00:00.000Z";

describe("R5 Session replay", () => {
  it("rebuilds the same visible block order and summaries as the live projection", () => {
    const live = new CliRuntimeProjection();
    live.pushUserMessage("user-1", "Run tests");
    for (const event of liveEvents()) live.applyAgentEvent(event);
    const persisted = live.presentationBlocks();
    const replay = buildSessionReplay(createDocument({ presentationBlocks: persisted }));
    const restored = new CliRuntimeProjection();
    for (const block of replay.blocks) restored.applyPresentationBlock(block);

    expect(restored.presentationBlocks()).toEqual(persisted);
    expect(restored.blocks.map(({ id, kind, summary }) => ({ id, kind, summary }))).toEqual(
      live.blocks.map(({ id, kind, summary }) => ({ id, kind, summary })),
    );
    expect(replay.diagnostics).toEqual([]);
  });

  it("uses the newest valid revision without letting blocks overwrite other kinds", () => {
    const assistant = block("assistant-1", 1, "assistant", "short");
    const tool = block("tool-1", 2, "tool", "done");
    const replay = buildSessionReplay(createDocument({
      presentationBlocks: [
        assistant,
        tool,
        { ...assistant, revision: 3, summary: "long answer", lines: ["long answer"] },
        { ...assistant, revision: 2, summary: "stale", lines: ["stale"] },
        { broken: true } as unknown as SessionPresentationBlock,
      ],
    }));

    expect(replay.blocks.map(({ id, kind, revision, summary }) => ({ id, kind, revision, summary }))).toEqual([
      { id: "assistant-1", kind: "assistant", revision: 3, summary: "long answer" },
      { id: "tool-1", kind: "tool", revision: 2, summary: "done" },
    ]);
    expect(replay.diagnostics).toEqual(["Skipped damaged presentation block at index 4."]);

    const projection = new CliRuntimeProjection();
    expect(projection.applyPresentationBlock(replay.blocks[0]!).changed).toBe(true);
    expect(projection.applyPresentationBlock({ ...assistant, revision: 2 }).changed).toBe(false);
    expect(projection.applyPresentationBlock({ ...tool, id: "assistant-1", revision: 4 }).changed).toBe(false);
    expect(projection.getBlock("assistant-1")?.summary).toBe("long answer");
    expect(projection.diagnostics).toContain(
      "Rejected presentation block assistant-1: kind changed from assistant to tool.",
    );
  });

  it("rebuilds legacy messages, tools, approvals, and extensions without executing tools", () => {
    const document = createDocument();
    document.runs[0]!.pluginNames = ["coding-tools"];
    document.runs[0]!.turns[0]!.messages = [
      { role: "user", content: "Read README" },
      { role: "assistant", content: "I will read it.", toolCalls: [{ id: "call-1", name: "read", input: { path: "README.md" } }] },
      { role: "tool", content: "contents", toolResult: { toolCallId: "call-1", name: "read", output: "contents" } },
      { role: "assistant", content: "Finished." },
    ];
    document.approvals.push({
      schemaVersion: "1",
      approvalId: "approval-1",
      runId: "run-1",
      turnId: "turn-1",
      state: "approved",
      record: {
        id: "record-1",
        requestFingerprint: "fingerprint",
        principalId: "local-user",
        actionKind: "tool.call",
        resourceScope: "README.md",
        operator: "user",
        decision: "allow",
        createdAt: now,
      },
    });

    const replay = buildSessionReplay(document);
    expect(replay.blocks.map((candidate) => candidate.kind)).toEqual([
      "user", "assistant", "tool", "assistant", "approval-result",
    ]);
    expect(replay.blocks.find((candidate) => candidate.kind === "tool")?.lines).toContain("status: done");
    expect(replay.extensionSnapshot?.extensions).toEqual([
      { id: "coding-tools", version: "unknown", enabled: true, health: "recorded" },
    ]);
  });

  it("keeps damaged and unrecoverable records in diagnostics only", () => {
    const document = createDocument();
    document.runs[0]!.turns[0]!.messages = [
      { role: "user", content: "safe" },
      { role: "broken", content: "must not render" } as never,
    ];
    document.approvals.push({ record: {} } as never);
    document.extensionSnapshot = { capturedAt: 42, extensions: "broken" } as never;

    const replay = buildSessionReplay(document);
    expect(replay.blocks.map((candidate) => candidate.summary)).toEqual(["safe"]);
    expect(replay.blocks.flatMap((candidate) => candidate.lines).join("\n")).not.toContain("must not render");
    expect(replay.diagnostics).toEqual([
      "Skipped damaged message at index 1.",
      "Skipped damaged approval summary.",
      "Ignored damaged extension snapshot.",
    ]);
  });
});

function createDocument(overrides: Partial<SessionDocument> = {}): SessionDocument {
  return {
    schemaVersion: "1",
    revision: 1,
    updatedAt: now,
    session: { sessionId: "session-1", state: "active", createdAt: now, updatedAt: now, lastRunId: "run-1" },
    runs: [{
      schemaVersion: "1",
      runId: "run-1",
      sessionId: "session-1",
      traceId: "trace-1",
      state: "succeeded",
      startedAt: now,
      endedAt: now,
      resolvedModel: "test",
      configHash: "config",
      pluginNames: [],
      policyVersion: "1",
      turns: [{
        schemaVersion: "1",
        turnId: "turn-1",
        runId: "run-1",
        state: "completed",
        sequence: 1,
        startedAt: now,
        endedAt: now,
        messages: [],
        toolInvocations: [],
      }],
    }],
    approvals: [],
    ...overrides,
  };
}

function block(
  id: string,
  revision: number,
  kind: SessionPresentationBlock["kind"],
  summary: string,
): SessionPresentationBlock {
  return { id, revision, kind, title: kind, state: "complete", summary, lines: [summary], live: false };
}

function liveEvents(): AgentEvent[] {
  const call = { id: "tool-1", name: "test", input: { scope: "unit" } };
  return [
    { type: "agent_start", eventId: "event-1", sequence: 1, source: "core", state: {} },
    { type: "message_start", eventId: "event-2", sequence: 1, source: "core", message: { id: "assistant-1", role: "assistant", content: "" } },
    { type: "message_update", eventId: "event-3", sequence: 2, source: "core", message: { id: "assistant-1", role: "assistant", content: "Working" } },
    { type: "message_end", eventId: "event-4", sequence: 3, source: "core", message: { id: "assistant-1", role: "assistant", content: "Working" } },
    { type: "tool_execution_start", eventId: "event-5", sequence: 1, source: "core", toolCall: call },
    { type: "tool_execution_end", eventId: "event-6", sequence: 2, source: "core", toolCall: call, result: { toolCallId: "tool-1", name: "test", output: "passed" } },
    { type: "agent_end", eventId: "event-7", sequence: 2, source: "core", state: {} },
  ] as AgentEvent[];
}
