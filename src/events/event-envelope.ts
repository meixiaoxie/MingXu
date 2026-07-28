export type RuntimeEventSource = "core" | "model" | "tool" | "plugin" | "memory" | "audit" | "cli";

export interface RuntimeEventEnvelope<TPayload = Record<string, unknown>> {
  version: "2026-07-28";
  eventId: string;
  eventType: string;
  occurredAt: string;
  sequence: number;
  runId: string;
  sessionId?: string;
  traceId?: string;
  source: RuntimeEventSource;
  payload: TPayload;
}
