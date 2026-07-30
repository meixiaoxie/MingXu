import { describe, expect, it, vi } from "vitest";

import { CliTuiApp } from "../src/cli/tui-app.js";
import type { CliRuntimeContext, CliRuntimeSnapshot } from "../src/cli/runtime-types.js";
import type { AgentSession } from "../src/core/agent-session.js";
import { ProcessTerminal } from "@mingxu/tui";

function createTerminal() {
  const keyListeners: Array<(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => void> = [];
  const terminal = {
    size: { columns: 80, rows: 12 },
    enterRawMode: vi.fn(),
    hideCursor: vi.fn(),
    showCursor: vi.fn(),
    restore: vi.fn(),
    render: vi.fn(),
    onKeypress(listener: (input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => void) {
      keyListeners.push(listener);
      return () => {
        const index = keyListeners.indexOf(listener);
        if (index >= 0) {
          keyListeners.splice(index, 1);
        }
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
  } as unknown as ProcessTerminal & {
    emit(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void;
  };
  return terminal;
}

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

function createSession(options: {
  readonly promptImpl?: (prompt: string, listeners: Array<(event: any) => void>) => Promise<{ content: string; messages: []; iterations: number; terminationReason: string }>;
} = {}): AgentSession {
  const listeners: Array<(event: any) => void> = [];
  return {
    state: { model: "primary", messages: [], tools: [], isStreaming: false, pendingToolCalls: [] },
    options: { model: { provider: "fake", generate: async () => ({ content: "", toolCalls: [] }) } as never },
    subscribe(listener: (event: any) => void) {
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
      return { content: "ok", messages: [], iterations: 1, terminationReason: "completed" };
    },
    followUp: () => undefined,
    steer: () => undefined,
    abort: () => undefined,
  } as unknown as AgentSession;
}

describe("phase B scrollback", () => {
  it("keeps long transcripts instead of trimming them to the viewport", async () => {
    const terminal = createTerminal();
    let promptCompleted: (() => void) | undefined;
    const promptDone = new Promise<void>((resolve) => {
      promptCompleted = resolve;
    });
    const session = createSession({
      promptImpl: async (_prompt, listeners) => {
        for (let index = 0; index < 40; index += 1) {
          const id = `assistant-${index}`;
          for (const listener of listeners) {
            listener({ type: "message_start", message: { role: "assistant", id, content: "" } });
            listener({
              type: "message_update",
              message: { role: "assistant", id, content: `block ${index}` },
              delta: { type: "text_delta", text: `block ${index}` },
            });
            listener({ type: "message_end", message: { role: "assistant", id, content: `block ${index}` } });
          }
        }
        promptCompleted?.();
        return { content: "done", messages: [], iterations: 1, terminationReason: "completed" };
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
      terminal,
      session,
      modelKey: "primary",
      sessionId: "session-1",
    });

    await app.refreshSnapshot();
    const startPromise = app.start("show history");
    await promptDone;

    const rendered = app.render(80).join("\n");
    expect(rendered).toContain("block 0");
    expect(rendered).toContain("block 39");

    app.exit();
    await expect(startPromise).resolves.toBe(0);
  });

  it("restores terminal state after a prompt failure", async () => {
    const terminal = createTerminal();
    const session = createSession({
      promptImpl: async () => {
        throw new Error("provider failed");
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
      terminal,
      session,
      modelKey: "primary",
      sessionId: "session-1",
    });

    await app.refreshSnapshot();
    await expect(app.runPrompt("boom")).rejects.toThrow("provider failed");
    expect(terminal.showCursor).toHaveBeenCalled();
    expect(terminal.restore).toHaveBeenCalled();
  });
});
