import { describe, expect, it, vi } from "vitest";

import { CliTuiApp } from "../src/cli/tui-app.js";
import type { CliRuntimeContext, CliRuntimeSnapshot } from "../src/cli/runtime-types.js";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ProcessTerminal } from "@mingxu/tui";

function createFakeTerminal() {
  const keyListeners: Array<(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => void> = [];
  return {
    size: { columns: 80, rows: 24 },
    enterRawMode() {},
    hideCursor() {},
    showCursor() {},
    restore() {},
    render() {},
    onKeypress(listener: (input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => void) {
      keyListeners.push(listener);
      return () => {
        const index = keyListeners.indexOf(listener);
        if (index >= 0) keyListeners.splice(index, 1);
      };
    },
    onResize() {
      return () => undefined;
    },
    emit(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) {
      for (const listener of keyListeners) {
        listener(input);
      }
    },
  } as unknown as ProcessTerminal & { emit(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void };
}

function createFakeSession(): AgentSession {
  return {
    state: { model: "primary", messages: [], tools: [], isStreaming: false, pendingToolCalls: [] },
    options: { model: { provider: "fake", generate: async () => ({ content: "", toolCalls: [] }) } as never },
    subscribe: () => () => undefined,
    prompt: async () => ({ content: "ok", messages: [], iterations: 1, terminationReason: "completed" }),
    followUp: () => undefined,
    steer: () => undefined,
    abort: () => undefined,
  } as unknown as AgentSession;
}

function createRuntimeSnapshot(): CliRuntimeSnapshot {
  return {
    configFilePath: "D:/project/mingxu.config.json",
    projectTrusted: true,
    configSources: [{ kind: "project", path: "D:/project/mingxu.config.json" }],
    defaultModel: "primary",
    models: [{ key: "primary", provider: "deepseek", model: "deepseek-v4-flash" }],
    sessions: [
      { sessionId: "session-1", state: "active", updatedAt: "2026-07-29T00:00:00.000Z", lastRunId: "run-1", lastRunState: "succeeded", title: "Demo" },
    ],
    resources: [
      { kind: "skill", name: "coding", visibility: "project", description: "Coding helper", source: "local_file", path: "D:/project/coding/SKILL.md" },
    ],
    skills: [
      { name: "coding", version: "1.0.0", description: "Coding helper", rootPath: "D:/project/coding", manifestPath: "D:/project/coding/skill.json", entryPath: "D:/project/coding/SKILL.md", visibility: "project", resources: [] },
    ],
    presets: [
      { version: "v1", name: "coding", description: "Coding preset", modelKey: "primary", tools: ["echo"] },
    ],
    extensions: [],
    mcpServers: [
      { name: "files", transport: "stdio", connected: false },
    ],
    subagents: {
      activeCount: 1,
      nodes: [
        {
          id: "session-1",
          sessionId: "session-1",
          prompt: "help",
          presetName: "coding",
          depth: 1,
          state: "running",
          startedAt: "2026-07-29T00:00:00.000Z",
          children: [],
        },
      ],
      tree: [
        {
          id: "session-1",
          label: "session-1 | coding | running",
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
      failClosedForHighRisk: true,
    },
    instructions: {
      systemPrompt: "You are MingXu.",
      autoLoadClaudeMd: false,
      managed: ["managed.md"],
      user: ["user.md"],
      project: ["project.md"],
      local: ["local.md"],
      session: ["session.md"],
    },
  };
}

describe("CliTuiApp", () => {
  it("renders browseable panels from the runtime snapshot", async () => {
    const runtime: CliRuntimeContext = {
      createSession: () => createFakeSession(),
      listSessions: async () => "session-1\tactive\t2026-07-29T00:00:00.000Z",
      listRecentSessions: async () => createRuntimeSnapshot().sessions,
      snapshot: async () => createRuntimeSnapshot(),
      close: async () => undefined,
    };

    const app = new CliTuiApp({
      runtime,
      terminal: createFakeTerminal(),
      session: createFakeSession(),
      modelKey: "primary",
      sessionId: "session-1",
    });

    await app.refreshSnapshot();
    await app.openHelpPanel();
    expect(app.render(80).join("\n")).toContain("Commands:");

    await app.openExtensionsPanel();
    const extensions = app.render(80).join("\n");
    expect(extensions).toContain("extensions");
    expect(extensions).toContain("coding");

    await app.openAgentsPanel();
    const agents = app.render(80).join("\n");
    expect(agents).toContain("agents");
    expect(agents).toContain("session-1");
  });

  it("shows an approval overlay and resolves decisions", async () => {
    const runtime: CliRuntimeContext = {
      createSession: () => createFakeSession(),
      listSessions: async () => "",
      listRecentSessions: async () => [],
      snapshot: async () => createRuntimeSnapshot(),
      close: async () => undefined,
    };
    const app = new CliTuiApp({
      runtime,
      terminal: createFakeTerminal(),
      session: createFakeSession(),
      modelKey: "primary",
      sessionId: "session-1",
    });

    await app.refreshSnapshot();
    const approval = app.openApproval({
      toolName: "readFile",
      toolCallId: "tool-1",
      principalId: "local-user",
      requestFingerprint: "fingerprint",
      actionKind: "tool.call",
      resourceScope: "file",
      reason: "need approval",
      input: { path: "README.md" },
      policyEffect: "ask",
    });
    expect(app.render(80).join("\n")).toContain("Allow once");
    app.handleInput({ sequence: "", name: "enter" });
    await expect(approval).resolves.toMatchObject({ decision: "allow" });
  });

  it("keeps approval above browse panels and filters session selectors", async () => {
    const runtime: CliRuntimeContext = {
      createSession: () => createFakeSession(),
      listSessions: async () => "session-1\tactive\t2026-07-29T00:00:00.000Z",
      listRecentSessions: async () => ([
        { sessionId: "alpha-1", state: "active", updatedAt: "2026-07-29T00:00:00.000Z" },
        { sessionId: "beta-2", state: "active", updatedAt: "2026-07-29T00:00:00.000Z" },
      ]),
      snapshot: async () => ({
        ...createRuntimeSnapshot(),
        sessions: [
          { sessionId: "alpha-1", state: "active", updatedAt: "2026-07-29T00:00:00.000Z" },
          { sessionId: "beta-2", state: "active", updatedAt: "2026-07-29T00:00:00.000Z" },
        ],
      }),
      close: async () => undefined,
    };
    const app = new CliTuiApp({
      runtime,
      terminal: createFakeTerminal(),
      session: createFakeSession(),
      modelKey: "primary",
      sessionId: "session-1",
    });

    await app.refreshSnapshot();
    await app.openHelpPanel();
    const approval = app.openApproval({
      toolName: "readFile",
      toolCallId: "tool-1",
      principalId: "local-user",
      requestFingerprint: "fingerprint",
      actionKind: "tool.call",
      resourceScope: "file",
      reason: "need approval",
      input: { path: "README.md" },
      policyEffect: "ask",
    });
    const approvalFrame = app.render(80).join("\n");
    expect(approvalFrame).toContain("Allow once");
    expect(approvalFrame).not.toContain("Commands:");
    app.handleInput({ sequence: "", name: "enter" });
    await expect(approval).resolves.toMatchObject({ decision: "allow" });

    await app.openSessionsPanel();
    app.handleInput({ sequence: "b", name: "b" });
    app.handleInput({ sequence: "e", name: "e" });
    const filtered = app.render(80).join("\n");
    expect(filtered).toContain("beta-2");
    expect(filtered).not.toContain("alpha-1");
  });

  it("shows unknown commands as transient composer notices", async () => {
    const runtime: CliRuntimeContext = {
      createSession: () => createFakeSession(),
      listSessions: async () => "",
      listRecentSessions: async () => [],
      snapshot: async () => createRuntimeSnapshot(),
      close: async () => undefined,
    };
    const app = new CliTuiApp({
      runtime,
      terminal: createFakeTerminal(),
      session: createFakeSession(),
      modelKey: "primary",
      sessionId: "session-1",
    });

    await app.refreshSnapshot();
    await app.handleSubmit("/does-not-exist");
    const rendered = app.render(80).join("\n");
    expect(rendered).toContain("Unknown command /does-not-exist");
    expect(rendered).not.toContain("run error");
    expect(rendered).not.toContain("unknown command");
  });

  it("restores a browse panel after closing a pushed detail overlay", async () => {
    const runtime: CliRuntimeContext = {
      createSession: () => createFakeSession(),
      listSessions: async () => "",
      listRecentSessions: async () => [],
      snapshot: async () => createRuntimeSnapshot(),
      close: async () => undefined,
    };
    const app = new CliTuiApp({
      runtime,
      terminal: createFakeTerminal(),
      session: createFakeSession(),
      modelKey: "primary",
      sessionId: "session-1",
    });

    await app.refreshSnapshot();
    await app.openExtensionsPanel();
    expect(app.activePanel?.kind).toBe("select");
    expect(app.render(80).join("\n")).toContain("preset coding");

    app.handleInput({ sequence: "", name: "enter" });
    expect(app.activePanel?.kind).toBe("text");
    expect(app.render(80).join("\n")).toContain("Coding preset");

    app.handleInput({ sequence: "", name: "escape" });
    expect(app.activePanel?.kind).toBe("select");
    const restored = app.render(80).join("\n");
    expect(restored).toContain("extensions");
    expect(restored).toContain("preset coding");
    expect(restored).toContain("showing 1-4 of 4");
    expect(restored).not.toContain("title: preset coding");
  });

  it("preserves composer selection, cursor, and preedit through resize and overlays", async () => {
    const runtime: CliRuntimeContext = {
      createSession: () => createFakeSession(),
      listSessions: async () => "",
      listRecentSessions: async () => [],
      snapshot: async () => createRuntimeSnapshot(),
      close: async () => undefined,
    };
    const app = new CliTuiApp({
      runtime,
      terminal: createFakeTerminal(),
      session: createFakeSession(),
      modelKey: "primary",
      sessionId: "session-1",
    });

    await app.refreshSnapshot();
    app.handleInput({ sequence: "中文🙂draft", name: "paste" });
    app.handleInput({ sequence: "", name: "a", ctrl: true });
    app.handleInput({ sequence: "", name: "right", shift: true });
    app.handleInput({ sequence: "", name: "right", shift: true });
    const selection = app.editor.selection;
    const cursor = app.editor.cursor;
    app.handleInput({ sequence: "かな", composition: "update" });

    for (const width of [60, 80, 120]) {
      app.render(width, 24);
      expect(app.editor.selection).toEqual(selection);
      expect(app.editor.cursor).toBe(cursor);
      expect(app.editor.composition).toEqual({ text: "かな", start: 0, end: 2 });
    }

    await app.openHelpPanel();
    app.handleInput({ sequence: "", name: "escape" });
    expect(app.activePanel).toBeUndefined();
    expect(app.editor.selection).toEqual(selection);
    expect(app.editor.cursor).toBe(cursor);
    expect(app.editor.composition).toEqual({ text: "かな", start: 0, end: 2 });
  });

  it("confirms Agent Tree cancellation, reports the result, and preserves the composer at low height", async () => {
    const cancelSubagents = vi.fn(async () => ({
      sessionId: "session-1",
      scope: "subtree" as const,
      status: "accepted" as const,
      targets: [{ sessionId: "session-1", status: "accepted" as const, reason: "Cancelled from Agent Tree" }],
    }));
    const runtime: CliRuntimeContext = {
      createSession: () => createFakeSession(),
      listSessions: async () => "",
      listRecentSessions: async () => [],
      snapshot: async () => createRuntimeSnapshot(),
      cancelSubagents,
      close: async () => undefined,
    };
    const app = new CliTuiApp({
      runtime,
      terminal: createFakeTerminal(),
      session: createFakeSession(),
      modelKey: "primary",
      sessionId: "session-1",
    });

    await app.refreshSnapshot();
    app.handleInput({ sequence: "draft", name: "paste" });
    await app.openAgentsPanel();
    app.handleInput({ sequence: "x", name: "x" });
    expect(app.activePanel?.title).toBe("cancel agent");
    expect(app.render(60, 10).at(-1)).toContain("> draft");

    app.handleInput({ sequence: "", name: "down" });
    app.handleInput({ sequence: "", name: "enter" });
    await vi.waitFor(() => expect(app.activePanel?.title).toBe("cancel result"));
    expect(cancelSubagents).toHaveBeenCalledWith({
      sessionId: "session-1",
      subtree: true,
      reason: "Cancelled from Agent Tree",
    });
    expect(app.render(60, 24).join("\n")).toContain("session-1: accepted");

    app.handleInput({ sequence: "", name: "escape" });
    expect(app.activePanel?.title).toBe("agents");
    expect(app.editor.value).toBe("draft");
  });
});
