import { describe, expect, it, vi } from "vitest";

import { RuntimeAdapter } from "../src/cli/runtime-adapter.js";
import type { CliRuntimeContext, CliRuntimeSnapshot } from "../src/cli/runtime-types.js";
import type { AgentSession } from "../src/core/agent-session.js";
import type { AgentLoopResult } from "../src/core/types.js";
import type { AgentEvent } from "../src/events/types.js";
import type { SessionDocument } from "../src/session/types.js";

describe("R5 RuntimeAdapter", () => {
  it("owns subscriptions across session switches and replays the selected session", async () => {
    const first = createSession();
    const second = createSession();
    const runtime = createRuntime([second.session]);
    runtime.loadSessionDocument = vi.fn(async (): Promise<SessionDocument> => ({
      schemaVersion: "1",
      revision: 1,
      updatedAt: "2026-07-31T00:00:00.000Z",
      session: { sessionId: "saved", state: "active", createdAt: "2026-07-31T00:00:00.000Z", updatedAt: "2026-07-31T00:00:00.000Z" },
      runs: [],
      approvals: [],
      presentationBlocks: [{ id: "saved-answer", revision: 4, kind: "assistant", title: "MingXu", state: "complete", summary: "restored", lines: ["restored"] }],
    }));
    const adapter = new RuntimeAdapter({ runtime, session: first.session });

    await expect(adapter.switchSession({ sessionId: "saved" })).resolves.toBe(true);
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    expect(runtime.loadSessionDocument).toHaveBeenCalledWith("saved");
    expect(adapter.projection.getBlock("saved-answer")?.summary).toBe("restored");

    first.emit(errorEvent("old session"));
    expect(adapter.projection.getBlock("agent-error")).toBeUndefined();
    second.emit(errorEvent("active session"));
    expect(adapter.projection.getBlock("agent-error")?.summary).toBe("active session");

    adapter.dispose();
    expect(second.unsubscribe).toHaveBeenCalledOnce();
  });

  it("stays busy until prompt settles, persists presentation, and continues after provider errors", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const firstRun = new Promise<AgentLoopResult>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const fake = createSession([
      () => firstRun,
      () => Promise.resolve({
        content: "recovered",
        messages: [],
        iterations: 1,
        terminationReason: "completed",
        sessionId: "session-1",
      }),
    ]);
    const runtime = createRuntime([]);
    runtime.saveSessionPresentation = vi.fn(async () => undefined);
    const adapter = new RuntimeAdapter({ runtime, session: fake.session, sessionId: "session-1" });

    const failed = adapter.runPrompt("first");
    fake.emit(errorEvent("provider unavailable"));
    expect(adapter.running).toBe(true);
    expect(adapter.projection.blocks.filter((block) => block.kind === "error")).toHaveLength(1);
    rejectFirst?.(new Error("provider unavailable"));
    await expect(failed).resolves.toBeUndefined();
    expect(adapter.running).toBe(false);
    expect(adapter.projection.blocks.filter((block) => block.kind === "error")).toHaveLength(1);

    fake.emit({ type: "agent_start", state: {}, eventId: "start-2", sequence: 1, source: "core" } as AgentEvent);
    fake.emit({ type: "message_start", message: { id: "answer-2", role: "assistant", content: "" }, eventId: "message-2-start", sequence: 1, source: "core" } as AgentEvent);
    fake.emit({ type: "message_end", message: { id: "answer-2", role: "assistant", content: "recovered" }, eventId: "message-2-end", sequence: 2, source: "core" } as AgentEvent);
    fake.emit({ type: "agent_end", state: {}, eventId: "end-2", sequence: 2, source: "core" } as AgentEvent);
    await expect(adapter.runPrompt("second")).resolves.toMatchObject({ content: "recovered" });
    expect(adapter.projection.getBlock("answer-2")?.summary).toBe("recovered");
    expect(runtime.saveSessionPresentation).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "session-1",
      blocks: expect.arrayContaining([expect.objectContaining({ id: "answer-2", summary: "recovered" })]),
    }));
  });
});

function createSession(promptRuns: Array<() => Promise<AgentLoopResult>> = []) {
  let listener: ((event: AgentEvent) => void) | undefined;
  let subscribed = false;
  const unsubscribe = vi.fn(() => {
    subscribed = false;
  });
  const prompt = vi.fn(async () => {
    const run = promptRuns.shift();
    return run ? run() : { content: "ok", messages: [], iterations: 1, terminationReason: "completed" as const };
  });
  const session = {
    state: { model: "test", messages: [], tools: [], isStreaming: false, pendingToolCalls: [] },
    options: { model: { provider: "fake", generate: async () => ({ content: "", toolCalls: [] }) } },
    subscribe(value: (event: AgentEvent) => void) {
      listener = value;
      subscribed = true;
      return unsubscribe;
    },
    prompt,
    followUp: vi.fn(),
    steer: vi.fn(),
    abort: vi.fn(),
  } as unknown as AgentSession;
  return { session, unsubscribe, emit: (event: AgentEvent) => subscribed ? listener?.(event) : undefined };
}

function createRuntime(sessions: AgentSession[]): CliRuntimeContext {
  return {
    createSession: vi.fn(() => sessions.shift() ?? createSession().session),
    listSessions: async () => "",
    listRecentSessions: async () => [],
    snapshot: async () => ({
      defaultModel: "test",
      models: [],
      sessions: [],
      resources: [],
      skills: [],
      presets: [],
      extensions: [],
      mcpServers: [],
      configSources: [],
      projectTrusted: true,
      configFilePath: "mingxu.config.json",
      subagents: { activeCount: 0, nodes: [], tree: [] },
      audit: { enabled: false, healthy: true, failClosedForHighRisk: true },
      instructions: {},
    } as CliRuntimeSnapshot),
    close: async () => undefined,
  };
}

function errorEvent(message: string): AgentEvent {
  return {
    type: "error",
    error: message,
    state: {},
    eventId: `error:${message}`,
    sequence: 1,
    source: "core",
  } as AgentEvent;
}
