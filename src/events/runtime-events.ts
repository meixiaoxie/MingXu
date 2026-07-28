import { randomUUID } from "node:crypto";

import type { RuntimeEventEnvelope, RuntimeEventSource } from "./event-envelope.js";

export interface RuntimeEventContext {
  runId: string;
  sequence: number;
  source: RuntimeEventSource;
  sessionId?: string;
  traceId?: string;
}

export function createRuntimeEvent<TPayload extends Record<string, unknown>>(
  eventType: string,
  payload: TPayload,
  context: RuntimeEventContext,
): RuntimeEventEnvelope<TPayload> {
  return {
    version: "2026-07-28",
    eventId: randomUUID(),
    eventType,
    occurredAt: new Date().toISOString(),
    sequence: context.sequence,
    runId: context.runId,
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context.traceId !== undefined ? { traceId: context.traceId } : {}),
    source: context.source,
    payload,
  };
}
