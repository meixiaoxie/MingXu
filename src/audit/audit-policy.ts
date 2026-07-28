export interface AuditPolicy {
  failClosedForHighRisk?: boolean;
  maxBytes?: number;
  maxFiles?: number;
}
