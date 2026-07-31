import { describe, expect, it } from "vitest";

import { CliRuntimeProjection } from "../src/cli/runtime-projection.js";
import type { AgentEvent } from "../src/events/types.js";

describe("CliRuntimeProjection", () => {
  it("buffers out-of-order assistant events and ignores stale duplicates", () => {
    const projection = new CliRuntimeProjection();

    const queuedUpdate = projection.applyAgentEvent({
      type: "message_update",
      eventId: "message-update-2",
      sequence: 2,
      source: "core",
      message: { id: "assistant-1", role: "assistant", content: "Hello" },
      delta: { type: "text_delta", text: "Hello" },
    } as AgentEvent);
    expect(queuedUpdate.changed).toBe(false);

    const start = projection.applyAgentEvent({
      type: "message_start",
      eventId: "message-start-1",
      sequence: 1,
      source: "core",
      message: { id: "assistant-1", role: "assistant", content: "" },
    } as AgentEvent);
    expect(start.changed).toBe(true);
    expect(projection.getBlock("assistant-1")?.summary).toBe("Hello");

    const staleDuplicate = projection.applyAgentEvent({
      type: "message_update",
      eventId: "message-update-2-duplicate",
      sequence: 2,
      source: "core",
      message: { id: "assistant-1", role: "assistant", content: "Hello" },
      delta: { type: "text_delta", text: "Hello" },
    } as AgentEvent);
    expect(staleDuplicate.changed).toBe(false);

    const end = projection.applyAgentEvent({
      type: "message_end",
      eventId: "message-end-1",
      sequence: 3,
      source: "core",
      message: { id: "assistant-1", role: "assistant", content: "Hello world" },
    } as AgentEvent);
    expect(end.changed).toBe(true);

    const block = projection.getBlock("assistant-1");
    expect(block?.state).toBe("complete");
    expect(block?.summary).toBe("Hello world");
    expect(projection.conversation.blocks).toHaveLength(1);
  });

  it("projects tool updates in place across out-of-order delivery", () => {
    const projection = new CliRuntimeProjection();
    const toolCall = { id: "tool-1", name: "read-file", input: { path: "README.md" } };

    const queuedUpdate = projection.applyAgentEvent({
      type: "tool_execution_update",
      eventId: "tool-update-2",
      sequence: 2,
      source: "core",
      toolCall,
      partialResult: { preview: "draft" },
    } as AgentEvent);
    expect(queuedUpdate.changed).toBe(false);

    const start = projection.applyAgentEvent({
      type: "tool_execution_start",
      eventId: "tool-start-1",
      sequence: 1,
      source: "core",
      toolCall,
    } as AgentEvent);
    expect(start.changed).toBe(true);
    expect(projection.getBlock("tool-1")?.state).toBe("streaming");

    const staleUpdate = projection.applyAgentEvent({
      type: "tool_execution_update",
      eventId: "tool-update-1",
      sequence: 1,
      source: "core",
      toolCall,
      partialResult: { preview: "stale" },
    } as AgentEvent);
    expect(staleUpdate.changed).toBe(false);

    const end = projection.applyAgentEvent({
      type: "tool_execution_end",
      eventId: "tool-end-1",
      sequence: 3,
      source: "core",
      toolCall,
      result: { toolCallId: "tool-1", name: "read-file", output: "done", isError: false, truncated: false },
    } as AgentEvent);
    expect(end.changed).toBe(true);

    const block = projection.getBlock("tool-1");
    expect(block?.state).toBe("complete");
    expect(block?.summary).toBe("done");
    expect(block?.revision).toBeGreaterThanOrEqual(3);
  });

  it("routes unrecoverable pending events to diagnostics without transcript errors", () => {
    const projection = new CliRuntimeProjection();
    projection.applyAgentEvent({
      type: "message_update",
      eventId: "orphan-update",
      sequence: 2,
      source: "core",
      message: { id: "missing-message", role: "assistant", content: "must not render" },
    } as AgentEvent);
    projection.applyAgentEvent({
      type: "agent_end",
      eventId: "agent-end",
      sequence: 3,
      source: "core",
      state: {},
    } as AgentEvent);

    expect(projection.blocks).toEqual([]);
    expect(projection.diagnostics).toEqual([
      "Dropped out-of-order events that never recovered. message events: missing-message",
    ]);
    expect(projection.render(80).join("\n")).not.toContain("must not render");
  });
});
