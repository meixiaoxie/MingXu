import { describe, expect, it } from "vitest";

import type { AgentSession } from "../src/core/agent-session.js";
import type { AgentLoopResult } from "../src/core/types.js";
import { AgentPresetRegistry } from "../src/presets/agent-preset-registry.js";
import { SubagentManager } from "../src/subagents/subagent-manager.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function completed(content = "done"): AgentLoopResult {
  return { content, messages: [], iterations: 1, terminationReason: "completed" };
}

function createManager(sessions: Map<string, { run: ReturnType<typeof deferred<AgentLoopResult>>; abort(reason?: string): void }>) {
  const presets = new AgentPresetRegistry().register({
    version: "v1",
    name: "worker",
    description: "test worker",
  });
  return new SubagentManager({
    presets,
    createSession: ({ sessionId }) => {
      const controlled = sessions.get(sessionId);
      if (!controlled) throw new Error(`Missing test session: ${sessionId}`);
      return {
        prompt: () => controlled.run.promise,
        abort: (reason?: string) => controlled.abort(reason),
      } as unknown as AgentSession;
    },
  });
}

describe("SubagentManager cancellation", () => {
  it("keeps cancellation final when a completed result arrives late", async () => {
    const run = deferred<AgentLoopResult>();
    const aborts: string[] = [];
    const manager = createManager(new Map([["root", { run, abort: (reason) => aborts.push(reason ?? "") }]]));
    const spawning = manager.spawn({ prompt: "work", presetName: "worker", sessionId: "root" });

    expect(manager.cancel({ sessionId: "root", reason: "stop" })).toMatchObject({
      status: "accepted",
      targets: [{ sessionId: "root", status: "accepted" }],
    });
    run.resolve(completed());
    await spawning;

    expect(aborts).toEqual(["stop"]);
    expect(manager.snapshot().nodes[0]).toMatchObject({ state: "cancelled", cancellationReason: "stop" });
    expect(manager.activeCount).toBe(0);
  });

  it("cancels a subtree deepest-first and reports already finished targets", async () => {
    const parentRun = deferred<AgentLoopResult>();
    const childRun = deferred<AgentLoopResult>();
    const order: string[] = [];
    const manager = createManager(new Map([
      ["parent", { run: parentRun, abort: () => order.push("parent") }],
      ["child", { run: childRun, abort: () => order.push("child") }],
    ]));
    const parent = manager.spawn({ prompt: "parent", presetName: "worker", sessionId: "parent", depth: 1 });
    const child = manager.spawn({ prompt: "child", presetName: "worker", sessionId: "child", parentSessionId: "parent", depth: 2 });

    const result = manager.cancel({ sessionId: "parent", subtree: true });
    expect(result.status).toBe("accepted");
    expect(result.targets.map((target) => target.sessionId)).toEqual(["child", "parent"]);
    expect(order).toEqual(["child", "parent"]);
    parentRun.resolve(completed());
    childRun.resolve(completed());
    await Promise.all([parent, child]);

    expect(manager.cancel({ sessionId: "parent" })).toMatchObject({
      status: "rejected",
      targets: [{ status: "rejected", reason: "Subagent already cancelled." }],
    });
    expect(manager.cancel({ sessionId: "missing" }).status).toBe("rejected");
  });

  it("reports abort failures and allows the running session to recover", async () => {
    const run = deferred<AgentLoopResult>();
    const manager = createManager(new Map([["root", {
      run,
      abort: () => { throw new Error("transport refused"); },
    }]]));
    const spawning = manager.spawn({ prompt: "work", presetName: "worker", sessionId: "root" });

    const result = manager.cancel({ sessionId: "root" });
    expect(result).toMatchObject({ status: "rejected", targets: [{ reason: "Cancellation failed: transport refused" }] });
    expect(manager.snapshot().nodes[0]).toMatchObject({ state: "running", cancellationError: "transport refused" });

    run.resolve(completed("recovered"));
    await spawning;
    expect(manager.snapshot().nodes[0]).toMatchObject({ state: "completed", content: "recovered" });
  });
});
