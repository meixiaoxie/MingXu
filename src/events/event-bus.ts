import type { RuntimeEvent } from "./types.js";

export interface EventBus<TEvent extends RuntimeEvent = RuntimeEvent> {
  emit(event: TEvent): Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
  isHealthy?(): boolean;
}

export class NoopEventBus<TEvent extends RuntimeEvent = RuntimeEvent> implements EventBus<TEvent> {
  async emit(_event: TEvent): Promise<void> {}
}
