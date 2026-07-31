import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { CliTuiApp } from "../src/cli/tui-app.js";
import type { CliRuntimeContext, CliRuntimeSnapshot } from "../src/cli/runtime-types.js";
import type { AgentSession } from "../src/core/agent-session.js";
import type { AgentEvent } from "../src/events/types.js";
import { createVirtualTerminal } from "./helpers/virtual-terminal.js";

const PROCESS_EVENTS = ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"] as const;

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
    audit: {
      enabled: true,
      file: "D:/project/.mingxu/audit.jsonl",
      healthy: true,
      failClosedForHighRisk: false,
    },
    instructions: {
      systemPrompt: "You are MingXu.",
      managed: [],
      user: [],
      project: [],
      local: [],
      session: [],
    },
  };
}

function createSession(options: {
  readonly prompt?: (listeners: readonly ((event: AgentEvent) => void)[]) => Promise<{
    readonly content: string;
    readonly messages: [];
    readonly iterations: number;
    readonly terminationReason: string;
  }>;
  readonly abort?: (reason?: string) => void;
} = {}): AgentSession {
  const listeners: Array<(event: AgentEvent) => void> = [];
  return {
    state: { model: "primary", messages: [], tools: [], isStreaming: false, pendingToolCalls: [] },
    options: { model: { provider: "fake", generate: async () => ({ content: "", toolCalls: [] }) } as never },
    subscribe(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    prompt: async () => options.prompt?.(listeners) ?? {
      content: "ok",
      messages: [],
      iterations: 1,
      terminationReason: "completed",
    },
    followUp: () => undefined,
    steer: () => undefined,
    abort: (reason?: string) => options.abort?.(reason),
  } as unknown as AgentSession;
}

function createRuntime(session: AgentSession): CliRuntimeContext {
  return {
    createSession: () => session,
    listSessions: async () => "",
    listRecentSessions: async () => [],
    snapshot: async () => createSnapshot(),
    close: async () => undefined,
  };
}

function createApp(session = createSession()) {
  const virtual = createVirtualTerminal();
  const processTarget = new EventEmitter();
  const app = new CliTuiApp({
    runtime: createRuntime(session),
    terminal: virtual.terminal,
    session,
    modelKey: "primary",
    processTarget: processTarget as unknown as Pick<NodeJS.Process, "on" | "off">,
  });
  return { app, processTarget, virtual };
}

function expectProcessListenersRemoved(processTarget: EventEmitter): void {
  for (const event of PROCESS_EVENTS) expect(processTarget.listenerCount(event)).toBe(0);
}

describe("CLI terminal lifecycle", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("restores and aborts a running session on %s", async (signal, exitCode) => {
    let resolvePrompt: (() => void) | undefined;
    const promptDone = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    const abort = vi.fn(() => resolvePrompt?.());
    const session = createSession({
      abort,
      prompt: async (listeners) => {
        for (const listener of listeners) {
          listener({
            type: "agent_start",
            state: { model: "primary", messages: [], tools: [], isStreaming: true, pendingToolCalls: [] },
          });
        }
        await promptDone;
        return { content: "", messages: [], iterations: 1, terminationReason: "aborted" };
      },
    });
    const { app, processTarget, virtual } = createApp(session);

    const running = app.start("wait for signal");
    await virtual.flush();
    processTarget.emit(signal);

    await expect(running).resolves.toBe(exitCode);
    expect(abort).toHaveBeenCalledWith(`Interrupted by ${signal}`);
    expectProcessListenersRemoved(processTarget);
    expect(virtual.writes.join("")).toContain("\x1b[?2026l\x1b[?2004l\x1b[?25h");
  });

  it.each(["uncaughtException", "unhandledRejection"] as const)(
    "restores and returns a failure for %s",
    async (event) => {
      const { app, processTarget, virtual } = createApp();
      const running = app.start();
      await virtual.flush();

      processTarget.emit(event, new Error(`${event} failure`));

      await expect(running).resolves.toBe(1);
      expectProcessListenersRemoved(processTarget);
      expect(virtual.writes.at(-1)).toBe("\x1b[?2026l\x1b[?2004l\x1b[?25h");
    },
  );

  it.each(["provider", "plugin"])("continues after a %s failure and restores on exit", async (source) => {
    let attempts = 0;
    const session = createSession({
      prompt: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error(`${source} failed`);
        return { content: "recovered", messages: [], iterations: 1, terminationReason: "completed" };
      },
    });
    const { app, processTarget, virtual } = createApp(session);

    const running = app.start("fail now");
    await vi.waitFor(() => {
      expect(attempts).toBe(1);
      expect(app.isRunning).toBe(false);
    });
    expect(processTarget.listenerCount("SIGINT")).toBe(1);
    expect(processTarget.listenerCount("uncaughtException")).toBe(1);

    await expect(app.runPrompt("try again")).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    app.exit();

    await expect(running).resolves.toBe(0);
    expectProcessListenersRemoved(processTarget);
    expect(virtual.writes.at(-1)).toBe("\x1b[?2026l\x1b[?2004l\x1b[?25h");
  });

  it("treats interactive stdout EPIPE as a clean restored exit", async () => {
    const { app, processTarget, virtual } = createApp();
    const setRawMode = vi.fn();
    virtual.input.setRawMode = setRawMode;
    const running = app.start();
    await virtual.flush();
    const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });

    (virtual.output as unknown as EventEmitter).emit("error", error);

    await expect(running).resolves.toBe(0);
    expectProcessListenersRemoved(processTarget);
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
    expect((virtual.input as unknown as EventEmitter).listenerCount("keypress")).toBe(0);
    expect((virtual.output as unknown as EventEmitter).listenerCount("error")).toBe(0);
  });

  it("cleans listeners when a signal arrives during resize", async () => {
    const { app, processTarget, virtual } = createApp();
    const running = app.start();
    await virtual.flush();

    virtual.resize(120, 40);
    processTarget.emit("SIGTERM");

    await expect(running).resolves.toBe(143);
    expectProcessListenersRemoved(processTarget);
    expect((virtual.output as unknown as EventEmitter).listenerCount("resize")).toBe(0);
  });

  it("does not leak process listeners across repeated interactive sessions", async () => {
    const processTarget = new EventEmitter();

    for (let index = 0; index < 3; index += 1) {
      const session = createSession();
      const virtual = createVirtualTerminal();
      const app = new CliTuiApp({
        runtime: createRuntime(session),
        terminal: virtual.terminal,
        session,
        processTarget: processTarget as unknown as Pick<NodeJS.Process, "on" | "off">,
      });
      const running = app.start();
      await virtual.flush();
      for (const event of PROCESS_EVENTS) expect(processTarget.listenerCount(event)).toBe(1);
      app.exit();
      await expect(running).resolves.toBe(0);
      expectProcessListenersRemoved(processTarget);
      expect(virtual.writes.at(-1)).toBe("\x1b[?2026l\x1b[?2004l\x1b[?25h");
    }
  });
});
