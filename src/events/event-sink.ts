import type { RuntimeEvent } from "./types.js";
import { NoopEventBus } from "./event-bus.js";

export type EventSink = {
  emit(event: RuntimeEvent): Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
  isHealthy?(): boolean;
};

export class NoopEventSink extends NoopEventBus implements EventSink {}
