import { performance } from "node:perf_hooks";

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
    subagents: {
      activeCount: 0,
      nodes: [],
      tree: [],
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

function createAssistantMessage(id: string, content: string) {
  return {
    id,
    role: "assistant" as const,
    content,
    createdAt: "2026-07-31T00:00:00.000Z",
  };
}

function emit(listeners: Array<(event: AgentEvent) => void>, event: AgentEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? 0;
}

describe("CLI performance gates", () => {
  it("keeps 200 streamed chunks visible with bounded redraws", async () => {
    const virtual = createVirtualTerminal({ columns: 80, rows: 24, scrollback: 4_000 });
    const listeners: Array<(event: AgentEvent) => void> = [];
    let resolvePrompt: ((value: {
      readonly content: string;
      readonly messages: [];
      readonly iterations: number;
      readonly terminationReason: string;
    }) => void) | undefined;
    const promptPromise = new Promise<{
      readonly content: string;
      readonly messages: [];
      readonly iterations: number;
      readonly terminationReason: string;
    }>((resolve) => {
      resolvePrompt = resolve;
    });
    const session = {
      state: { model: "primary", messages: [], tools: [], isStreaming: false, pendingToolCalls: [] },
      subscribe(listener: (event: AgentEvent) => void) {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        };
      },
      prompt: async () => promptPromise,
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

    const startPromise = app.start("performance probe");
    await new Promise((resolve) => setImmediate(resolve));

    emit(listeners, {
      type: "agent_start",
      state: { model: "primary", messages: [], tools: [], isStreaming: true, pendingToolCalls: [] },
    });
    emit(listeners, {
      type: "message_start",
      message: createAssistantMessage("assistant-perf", ""),
    });
    await virtual.flush();

    const batchLatencies: number[] = [];
    let content = "";
    for (let batchIndex = 0; batchIndex < 20; batchIndex += 1) {
      const startedAt = performance.now();
      for (let index = 0; index < 10; index += 1) {
        const chunkNumber = batchIndex * 10 + index;
        const chunk = `chunk-${String(chunkNumber).padStart(3, "0")} `;
        content += chunk;
        emit(listeners, {
          type: "message_update",
          message: createAssistantMessage("assistant-perf", content),
          delta: { type: "text_delta", text: chunk },
        });
      }
      await virtual.flush();
      batchLatencies.push(performance.now() - startedAt);
    }

    emit(listeners, {
      type: "message_end",
      message: createAssistantMessage("assistant-perf", content),
    });
    emit(listeners, {
      type: "agent_end",
      state: { model: "primary", messages: [], tools: [], isStreaming: false, pendingToolCalls: [] },
    });

    resolvePrompt?.({
      content,
      messages: [],
      iterations: 1,
      terminationReason: "completed",
    });
    app.exit();

    await expect(startPromise).resolves.toBe(0);

    const output = virtual.writes.join("");
    const renderFrameCount = (output.match(/\u001b\[\?2026h/g) ?? []).length;
    const clearCount = (output.match(/\u001b\[2J/g) ?? []).length;

    expect(output).toContain("chunk-199");
    expect(virtual.screen.buffer.active.baseY).toBeGreaterThan(0);
    expect(renderFrameCount).toBeLessThanOrEqual(30);
    expect(clearCount).toBe(1);
    expect(batchLatencies.length).toBe(20);
    expect(percentile(batchLatencies, 0.95)).toBeLessThan(100);
  });
});
