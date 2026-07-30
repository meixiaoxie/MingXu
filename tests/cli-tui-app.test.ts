import { describe, expect, it } from "vitest";

import { CliTuiApp } from "../src/cli/tui-app.js";
import type { CliRuntimeContext, CliRuntimeSnapshot } from "../src/cli/runtime-types.js";
import type { AgentSession } from "../src/core/agent-session.js";

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
  } as unknown as import("../src/tui/terminal.js").ProcessTerminal & { emit(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void };
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
          label: "session-1 • coding • running",
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

  it("accumulates streamed assistant deltas into one rendered block", async () => {
    const listeners: Array<(event: any) => void> = [];
    let app: CliTuiApp;

    const runtime: CliRuntimeContext = {
      createSession: () =>
        ({
          state: { model: "primary", messages: [], tools: [], isStreaming: false, pendingToolCalls: [] },
          options: { model: { provider: "fake", generate: async () => ({ content: "", toolCalls: [] }) } as never },
          subscribe: (listener: (event: any) => void) => {
            listeners.push(listener);
            return () => {
              const index = listeners.indexOf(listener);
              if (index >= 0) listeners.splice(index, 1);
            };
          },
          prompt: async (prompt: string) => {
            expect(prompt).toBe("你好");
            for (const listener of listeners) {
              listener({ type: "message_start", message: { role: "assistant", content: "" } });
              listener({ type: "message_update", message: { role: "assistant", content: "你" }, delta: { type: "text_delta", text: "你" } });
            }
            expect(app.render(80).join("\n")).toContain("你");
            for (const listener of listeners) {
              listener({ type: "message_update", message: { role: "assistant", content: "你好" }, delta: { type: "text_delta", text: "好" } });
              listener({ type: "message_end", message: { role: "assistant", content: "你好" } });
            }
            return { content: "你好", messages: [], iterations: 1, terminationReason: "completed" };
          },
          followUp: () => undefined,
          steer: () => undefined,
          abort: () => undefined,
        }) as unknown as AgentSession,
      listSessions: async () => "",
      listRecentSessions: async () => [],
      snapshot: async () => createRuntimeSnapshot(),
      close: async () => undefined,
    };

    app = new CliTuiApp({
      runtime,
      terminal: createFakeTerminal(),
      session: createFakeSession(),
      modelKey: "primary",
      sessionId: "session-1",
    });

    await app.refreshSnapshot();
    await app.runPrompt("你好");

    const rendered = app.render(80).join("\n");
    expect(rendered).toContain("你好");
    expect(rendered).not.toContain("\n  你\n  好");
  });
});
