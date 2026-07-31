import { describe, expect, it } from "vitest";

import { CliTuiApp } from "../src/cli/tui-app.js";
import type { CliRuntimeContext, CliRuntimeSnapshot } from "../src/cli/runtime-types.js";
import type { AgentSession } from "../src/core/agent-session.js";
import type { AgentEvent } from "../src/events/types.js";
import { createVirtualTerminal } from "./helpers/virtual-terminal.js";

function createSnapshot(): CliRuntimeSnapshot {
  return {
    configFilePath: "D:/project/mingxu.config.json",
    projectTrusted: true,
    configSources: [{ kind: "project", path: "D:/project/mingxu.config.json" }],
    defaultModel: "primary",
    models: [{ key: "primary", provider: "fake", model: "fake-model" }],
    sessions: [],
    resources: [],
    skills: [],
    presets: [],
    extensions: [],
    mcpServers: [],
    subagents: { activeCount: 0, nodes: [], tree: [] },
    audit: { enabled: false, healthy: true, failClosedForHighRisk: false },
    instructions: {},
  };
}

function createAssistantMessage(id: string, content: string) {
  return {
    id,
    role: "assistant" as const,
    content,
    createdAt: "2026-07-31T00:00:00.000Z",
  };
}

function createHarness(options: {
  readonly columns?: number;
  readonly rows?: number;
  readonly scrollback?: number;
} = {}) {
  const virtual = createVirtualTerminal(options);
  const listeners: Array<(event: AgentEvent) => void> = [];
  const session = {
    state: { model: "primary", messages: [], tools: [], isStreaming: false, pendingToolCalls: [] },
    options: { model: { provider: "fake", generate: async () => ({ content: "", toolCalls: [] }) } as never },
    subscribe(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    prompt: async () => ({ content: "ok", messages: [], iterations: 1, terminationReason: "completed" }),
    followUp: () => undefined,
    steer: () => undefined,
    abort: () => undefined,
  } as unknown as AgentSession;
  const runtime: CliRuntimeContext = {
    createSession: () => session,
    listSessions: async () => "",
    listRecentSessions: async () => [],
    snapshot: async () => createSnapshot(),
    close: async () => undefined,
  };
  const app = new CliTuiApp({
    runtime,
    terminal: virtual.terminal,
    session,
    modelKey: "primary",
    sessionId: "session-1",
  });
  return {
    app,
    virtual,
    emit(event: AgentEvent): void {
      for (const listener of listeners) listener(event);
    },
  };
}

function emitCompletedAssistant(
  emit: (event: AgentEvent) => void,
  id: string,
  content: string,
): void {
  emit({ type: "message_start", message: createAssistantMessage(id, "") });
  emit({
    type: "message_update",
    message: createAssistantMessage(id, content),
    delta: { type: "text_delta", text: content },
  });
  emit({ type: "message_end", message: createAssistantMessage(id, content) });
}

describe("R1 CLI scrollback", () => {
  it("commits completed blocks once and does not replay them for late events or overlays", async () => {
    const { app, virtual, emit } = createHarness({ columns: 80, rows: 24, scrollback: 500 });
    const startPromise = app.start();
    await virtual.flush();
    const transcriptStart = virtual.writes.length;

    const settledText = "settled-answer-r1";
    emitCompletedAssistant(emit, "assistant-settled", settledText);
    await virtual.flush();

    const committedBytes = virtual.writes.slice(transcriptStart).join("");
    expect(committedBytes.split(settledText)).toHaveLength(2);
    expect(app.transcriptStats).toEqual({ committedBlockCount: 1, activeBlockCount: 0 });
    expect(await virtual.readText()).toContain(settledText);

    const laterStart = virtual.writes.length;
    emit({ type: "message_end", message: createAssistantMessage("assistant-settled", settledText) });
    emit({
      type: "message_update",
      message: createAssistantMessage("assistant-settled", "stale"),
      delta: { type: "text_delta", text: "stale" },
    });
    const approval = app.openApproval({
      toolName: "readFile",
      toolCallId: "tool-r1",
      principalId: "local-user",
      requestFingerprint: "fingerprint-r1",
      actionKind: "tool.call",
      resourceScope: "file",
      reason: "verify overlay",
      input: { path: "README.md" },
      policyEffect: "ask",
    });
    await virtual.flush();
    virtual.press({ sequence: "", name: "enter" });
    await expect(approval).resolves.toMatchObject({ decision: "allow", scope: "once" });
    await virtual.flush();

    const laterBytes = virtual.writes.slice(laterStart).join("");
    expect(laterBytes).not.toContain(settledText);
    expect(laterBytes).not.toContain("stale");
    expect(laterBytes).not.toContain("\u001b[2J");

    app.exit();
    await expect(startPromise).resolves.toBe(0);
  });

  it("keeps 1,000 completed messages out of the active render set", async () => {
    const { app, virtual, emit } = createHarness({ columns: 80, rows: 24, scrollback: 4_000 });
    const startPromise = app.start();
    await virtual.flush();

    for (let index = 0; index < 1_000; index += 1) {
      emitCompletedAssistant(
        emit,
        `assistant-history-${index}`,
        `history-r1-${String(index).padStart(4, "0")}`,
      );
    }
    await virtual.flush();

    expect(app.transcriptStats).toEqual({ committedBlockCount: 1_000, activeBlockCount: 0 });
    expect(virtual.terminal.renderStats.activeLineCount).toBeLessThan(20);
    expect(virtual.screen.buffer.active.baseY).toBeGreaterThan(0);
    const scrollback = await virtual.readText();
    expect(scrollback).toContain("history-r1-0000");
    expect(scrollback).toContain("history-r1-0999");

    const deltaStart = virtual.writes.length;
    emit({ type: "message_start", message: createAssistantMessage("assistant-live", "") });
    emit({
      type: "message_update",
      message: createAssistantMessage("assistant-live", "live-tail-r1"),
      delta: { type: "text_delta", text: "live-tail-r1" },
    });
    await virtual.flush();

    const deltaBytes = virtual.writes.slice(deltaStart).join("");
    expect(deltaBytes).toContain("live-tail-r1");
    expect(deltaBytes).not.toContain("history-r1-0000");
    expect(deltaBytes).not.toContain("history-r1-0999");
    expect(deltaBytes).not.toContain("\u001b[2J");
    expect(virtual.terminal.renderStats.renderedLineCount).toBeLessThan(10);
    expect(app.transcriptStats).toEqual({ committedBlockCount: 1_000, activeBlockCount: 1 });

    app.exit();
    await expect(startPromise).resolves.toBe(0);
  });

  it("replays committed history only when resize requires recovery", async () => {
    const { app, virtual, emit } = createHarness({ columns: 80, rows: 24, scrollback: 1_000 });
    const startPromise = app.start();
    await virtual.flush();
    emitCompletedAssistant(emit, "assistant-wide", "resize-r1 中文 😀 long transcript line");
    await virtual.flush();

    for (const [columns, rows] of [[60, 20], [80, 24], [120, 40]] as const) {
      const resizeStart = virtual.writes.length;
      virtual.resize(columns, rows);
      await virtual.flush();
      const resizeBytes = virtual.writes.slice(resizeStart).join("");
      expect(resizeBytes, `${columns}x${rows} should replay history`).toContain("resize-r1");
      expect(resizeBytes, `${columns}x${rows} should clear only for recovery`).toContain("\u001b[2J");
      expect(await virtual.readText(), `${columns}x${rows} should preserve wide text`).toContain("中文");
    }

    expect(virtual.terminal.renderStats.lastFullRedrawReason).toBe("width-change");
    const heightOnlyStart = virtual.writes.length;
    virtual.resize(120, 30);
    await virtual.flush();
    const heightOnlyBytes = virtual.writes.slice(heightOnlyStart).join("");
    expect(heightOnlyBytes).not.toContain("resize-r1");
    expect(heightOnlyBytes).not.toContain("\u001b[2J");
    expect(await virtual.readText()).toContain("中文");
    app.exit();
    await expect(startPromise).resolves.toBe(0);
  });
});
