import { describe, expect, it } from "vitest";

import { createRuntimeEvent } from "../src/events/runtime-events.js";

describe("runtime events", () => {
  it("creates versioned envelopes with ids and sequence", () => {
    const event = createRuntimeEvent("model.request.start", { messageCount: 1 }, {
      runId: "run-1",
      sessionId: "session-1",
      traceId: "trace-1",
      sequence: 3,
      source: "model",
    });

    expect(event).toMatchObject({
      version: "2026-07-28",
      eventType: "model.request.start",
      runId: "run-1",
      sessionId: "session-1",
      traceId: "trace-1",
      sequence: 3,
      source: "model",
      payload: { messageCount: 1 },
    });
    expect(event.eventId).toBeTruthy();
    expect(event.occurredAt).toBeTruthy();
  });
});
