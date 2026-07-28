import type { RuntimeEventEnvelope } from "../events/event-envelope.js";

export interface AuditWriter {
  write(event: RuntimeEventEnvelope): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  isHealthy(): boolean;
}
