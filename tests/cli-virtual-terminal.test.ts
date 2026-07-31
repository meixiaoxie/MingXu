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
    sessions: [
      { sessionId: "session-1", state: "active", updatedAt: "2026-07-31T00:00:00.000Z" },
    ],
    resources: [],
    skills: [],
    presets: [],
    extensions: [],
    mcpServers: [],
    subagents: {
      activeCount: 1,
      nodes: [
        {
          id: "node-1",
          sessionId: "session-1",
          prompt: "show transcript",
          presetName: "default",
          depth: 1,
          state: "running",
          startedAt: "2026-07-31T00:00:00.000Z",
          children: [],
        },
      ],
      tree: [
        {
          id: "node-1",
          label: "session-1 | default | running",
          state: "running",
          depth: 1,
          children: [],
        },
      ],
    },
    audit: {
      enabled: true,
      file: "D:/project/.mingxu/audit.jsonl",
      healthy: true,
      failClosedForHighRisk: false,
    },
    instructions: {
      systemPrompt: "You are MingXu.",
      managed: ["managed.md"],
      user: ["user.md"],
      project: ["project.md"],
      local: ["local.md"],
      session: ["session.md"],
    },
  };
}

function createSession(options: {
  readonly promptImpl?: (prompt: string, listeners: Array<(event: AgentEvent) => void>) => Promise<{
    readonly content: string;
    readonly messages: [];
    readonly iterations: number;
    readonly terminationReason: string;
  }>;
  readonly abortImpl?: (reason?: string) => void;
} = {}): AgentSession {
  const listeners: Array<(event: AgentEvent) => void> = [];
  return {
    state: { model: "primary", messages: [], tools: [], isStreaming: false, pendingToolCalls: [] },
    options: { model: { provider: "fake", generate: async () => ({ content: "", toolCalls: [] }) } as never },
    subscribe(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
    prompt: async (prompt: string) => {
      if (options.promptImpl) {
        return await options.promptImpl(prompt, listeners);
      }
      return { content: "done", messages: [], iterations: 1, terminationReason: "completed" };
    },
    followUp: () => undefined,
    steer: () => undefined,
    abort: (reason?: string) => options.abortImpl?.(reason),
  } as unknown as AgentSession;
}

function emit(listeners: Array<(event: AgentEvent) => void>, event: AgentEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

function createAssistantMessage(id: string, content: string) {
  return {
    id,
    role: "assistant" as const,
    content,
    createdAt: "2026-07-31T00:00:00.000Z",
  };
}

function createToolCall(id: string, name: string, input: unknown) {
  return { id, name, input };
}

function createToolResult(toolCallId: string, toolName: string, input: unknown, output: string) {
  return {
    toolCallId,
    toolName,
    name: toolName,
    state: "completed" as const,
    input,
    output,
    isError: false,
  };
}

function createEventSequence(): { readonly finalContent: string; readonly events: AgentEvent[] } {
  const wideText = "\u4e2d\u6587 \u{1f600}";
  const imeText = "\u6f22\u5b57\u304b\u306a";
  const chunks = Array.from({ length: 220 }, (_, index) => `chunk-${String(index).padStart(3, "0")} `);
  const tail = [
    "",
    "## \u6807\u9898",
    "",
    "```markdown",
    "- alpha",
    "- beta",
    "```",
    "",
    "```diff",
    "+ added line",
    "- removed line",
    "```",
    "",
    "Command: pnpm test",
    "",
    "Paste:",
    "line one",
    "line two",
    "",
    wideText,
    imeText,
    "IME \u8f93\u5165",
  ].join("\n");

  const promptId = "assistant-1";
  let content = "";
  const events: AgentEvent[] = [
    {
      type: "agent_start",
      state: { model: "primary", messages: [], tools: [], isStreaming: true, pendingToolCalls: [] },
    },
    {
      type: "turn_start",
      turnId: "turn-1",
      input: createAssistantMessage("user-1", "show transcript"),
    },
    {
      type: "message_start",
      message: createAssistantMessage(promptId, ""),
    },
  ];

  for (const chunk of chunks) {
    content += chunk;
    events.push({
      type: "message_update",
      message: createAssistantMessage(promptId, content),
      delta: { type: "text_delta", text: chunk },
    });
  }

  content += tail;
  events.push(
    {
      type: "message_update",
      message: createAssistantMessage(promptId, content),
      delta: { type: "text_delta", text: tail },
    },
    {
      type: "tool_execution_start",
      toolCall: createToolCall("tool-markdown", "markdown-tool", { view: "markdown" }),
    },
    {
      type: "tool_execution_start",
      toolCall: createToolCall("tool-diff", "diff-tool", { view: "diff" }),
    },
    {
      type: "tool_execution_end",
      toolCall: createToolCall("tool-diff", "diff-tool", { view: "diff" }),
      result: createToolResult(
        "tool-diff",
        "diff-tool",
        { view: "diff" },
        [
          "```diff",
          "+ added line",
          "- removed line",
          "```",
          "Command: pnpm test",
        ].join("\n"),
      ),
    },
    {
      type: "tool_execution_end",
      toolCall: createToolCall("tool-markdown", "markdown-tool", { view: "markdown" }),
      result: createToolResult(
        "tool-markdown",
        "markdown-tool",
        { view: "markdown" },
        [
          "## \u6807\u9898",
          "",
          "```markdown",
          "- alpha",
          "- beta",
          "```",
          "",
          wideText,
          imeText,
          "IME \u8f93\u5165",
        ].join("\n"),
      ),
    },
    {
      type: "message_end",
      message: createAssistantMessage(promptId, content),
    },
    {
      type: "agent_end",
      state: { model: "primary", messages: [], tools: [], isStreaming: false, pendingToolCalls: [] },
    },
  );

  return { finalContent: content, events };
}

describe("CLI VirtualTerminal", () => {
  it("renders streamed content across 60x20, 80x24, and 120x40 terminals", async () => {
    const virtual = createVirtualTerminal({ columns: 60, rows: 20, scrollback: 2_000 });
    const { events, finalContent } = createEventSequence();
    const session = createSession({
      promptImpl: async (_prompt, listeners) => {
        for (const event of events) {
          emit(listeners, event);
        }
        return { content: finalContent, messages: [], iterations: 1, terminationReason: "completed" };
      },
    });
    const runtime: CliRuntimeContext = {
      createSession: () => session,
      listSessions: async () => "session-1\tactive\t2026-07-31T00:00:00.000Z",
      listRecentSessions: async () => createSnapshot().sessions,
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

    await app.refreshSnapshot();
    const startPromise = app.start("show transcript");
    await virtual.flush();
    let rendered = await virtual.readText();
    expect(rendered).toContain("chunk-000");
    expect(rendered).toContain("chunk-219");
    expect(rendered).toContain("\u4e2d\u6587");
    expect(rendered).toContain("\u{1f600}");
    expect(rendered).toContain("Command: pnpm test");
    expect(virtual.screen.buffer.active.baseY).toBeGreaterThan(0);

    virtual.resize(80, 24);
    await virtual.flush();
    rendered = await virtual.readText();
    expect(rendered).toContain("chunk-219");
    expect(rendered).toContain("IME \u8f93\u5165");

    virtual.resize(120, 40);
    await virtual.flush();
    rendered = await virtual.readText();
    expect(rendered).toContain("chunk-000");
    expect(rendered).toContain("```diff");

    app.exit();
    await expect(startPromise).resolves.toBe(0);
  });

  it("renders overlays above the transcript and keeps approval input working", async () => {
    const virtual = createVirtualTerminal({ columns: 80, rows: 24 });
    const session = createSession();
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

    const startPromise = app.start();
    await new Promise((resolve) => setImmediate(resolve));
    const approval = app.openApproval({
      toolName: "readFile",
      toolCallId: "tool-approval-1",
      principalId: "local-user",
      requestFingerprint: "fingerprint",
      actionKind: "tool.call",
      resourceScope: "file",
      reason: "need approval",
      input: { path: "README.md" },
      policyEffect: "ask",
    });

    await virtual.flush();
    const rendered = await virtual.readText();
    expect(rendered).toContain("Allow once");
    expect(rendered).toContain("Allow for session");
    expect(rendered).toContain("Deny");

    virtual.press({ sequence: "", name: "enter" });
    await expect(approval).resolves.toMatchObject({ decision: "allow", scope: "once" });
    app.exit();
    await expect(startPromise).resolves.toBe(0);
  });

  it("aborts a running prompt with Ctrl+C and exits on Ctrl+D", async () => {
    const virtual = createVirtualTerminal({ columns: 80, rows: 24 });
    let resolvePrompt: ((value: { content: string; messages: []; iterations: number; terminationReason: string }) => void) | undefined;
    let aborted = 0;
    const promptPromise = new Promise<{ content: string; messages: []; iterations: number; terminationReason: string }>((resolve) => {
      resolvePrompt = resolve;
    });
    const session = createSession({
      abortImpl: () => {
        aborted += 1;
        resolvePrompt?.({ content: "", messages: [], iterations: 1, terminationReason: "aborted" });
      },
      promptImpl: async (_prompt, listeners) => {
        emit(listeners, {
          type: "agent_start",
          state: { model: "primary", messages: [], tools: [], isStreaming: true, pendingToolCalls: [] },
        });
        emit(listeners, {
          type: "message_start",
          message: createAssistantMessage("assistant-running", ""),
        });
        return await promptPromise;
      },
    });
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

    const running = app.start("keep running");
    await virtual.flush();
    virtual.press({ sequence: "", name: "c", ctrl: true });
    await virtual.flush();
    expect(aborted).toBe(1);
    expect(await virtual.readText()).toContain("aborted");
    virtual.press({ sequence: "", name: "c", ctrl: true });
    virtual.press({ sequence: "", name: "c", ctrl: true });
    await expect(running).resolves.toBe(0);
    expect(virtual.writes.at(-1)).toBe("\x1b[?2026l\x1b[?2004l\x1b[?25h");

    const exitSession = createSession();
    const exitTerminal = createVirtualTerminal({ columns: 80, rows: 24 });
    const exitOnlyApp = new CliTuiApp({
      runtime: {
        ...runtime,
        createSession: () => exitSession,
      },
      terminal: exitTerminal.terminal,
      session: exitSession,
      modelKey: "primary",
      sessionId: "session-1",
    });
    const startPromise = exitOnlyApp.start();
    await exitTerminal.flush();
    exitTerminal.press({ sequence: "", name: "d", ctrl: true });
    await exitTerminal.flush();
    expect(await exitTerminal.readText()).toContain("Press Ctrl+D again to exit");
    exitTerminal.press({ sequence: "", name: "d", ctrl: true });
    await expect(startPromise).resolves.toBe(0);
    expect(exitTerminal.writes.at(-1)).toBe("\x1b[?2026l\x1b[?2004l\x1b[?25h");
  });

  it("keeps IME preedit out of the prompt until ProcessTerminal forwards a commit", async () => {
    const virtual = createVirtualTerminal({ columns: 80, rows: 24 });
    const session = createSession();
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

    const running = app.start();
    await virtual.flush();
    virtual.press({ sequence: "", composition: "start" });
    virtual.press({ sequence: "中文", composition: "update" });
    await virtual.flush();
    expect(app.editor.value).toBe("");
    expect(app.editor.composition).toEqual({ text: "中文", start: 0, end: 0 });
    expect(await virtual.readText()).toContain("中文");

    virtual.press({ sequence: "中文", composition: "commit" });
    await virtual.flush();
    expect(app.editor.value).toBe("中文");
    expect(app.editor.composition).toBeUndefined();
    app.exit();
    await expect(running).resolves.toBe(0);
  });
});
