import type { ApprovalRecord } from "../approval/types.js";
import type { Message, RunTerminationReason, ToolResult } from "../core/types.js";

export interface SessionRecord {
  sessionId: string;
  state: "active" | "archived" | "deleted";
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
  title?: string;
}

export interface SessionToolInvocationRecord {
  schemaVersion: string;
  invocationId: string;
  toolCallId: string;
  toolName: string;
  state: "pending" | "running" | "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
}

export interface SessionTurnRecord {
  schemaVersion: string;
  turnId: string;
  runId: string;
  state: "pending" | "running" | "completed" | "failed";
  sequence: number;
  startedAt: string;
  endedAt?: string;
  messages: Message[];
  toolInvocations: SessionToolInvocationRecord[];
}

export interface SessionRunRecord {
  schemaVersion: string;
  runId: string;
  sessionId: string;
  traceId: string;
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
  startedAt: string;
  endedAt?: string;
  interruptedAt?: string;
  resolvedModel: string;
  configHash: string;
  pluginNames: string[];
  policyVersion: string;
  terminationReason?: RunTerminationReason;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    modelRequests: number;
  };
  turns: SessionTurnRecord[];
}

export interface SessionApprovalRecord {
  schemaVersion: string;
  approvalId: string;
  runId?: string;
  turnId?: string;
  state: "pending" | "approved" | "denied" | "expired" | "cancelled";
  record: ApprovalRecord;
}

export interface SessionDocument {
  schemaVersion: string;
  revision: number;
  updatedAt: string;
  session: SessionRecord;
  runs: SessionRunRecord[];
  approvals: SessionApprovalRecord[];
}

export interface SessionSummary {
  sessionId: string;
  state: SessionRecord["state"];
  updatedAt: string;
  lastRunId?: string;
  lastRunState?: SessionRunRecord["state"];
  title?: string;
}

export interface SessionWriteResult {
  document: SessionDocument;
  revision: number;
}

export interface SessionRuntimeSnapshot {
  messages: Message[];
  latestRun?: SessionRunRecord;
  latestTurn?: SessionTurnRecord;
}
