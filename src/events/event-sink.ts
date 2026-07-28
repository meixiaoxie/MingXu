import type { RuntimeEventEnvelope } from "./event-envelope.js";

export interface EventSink {
  emit(event: RuntimeEventEnvelope): Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
  isHealthy?(): boolean;
}

export class NoopEventSink implements EventSink {
  async emit(_event: RuntimeEventEnvelope): Promise<void> {}
}
