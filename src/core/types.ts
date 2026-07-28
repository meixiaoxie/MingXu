// These shared types are the small contract between the agent, models, and tools.
// Keeping them vendor-neutral lets the runtime swap Anthropic for another model later.
import type { MemoryStore } from "../memory/memory-store.js";
import type { EventSink } from "../events/event-sink.js";
import type { SecretRef } from "../redaction/secret-ref.js";
import type { ApprovalStore } from "../approval/types.js";
import type { PolicyEngine } from "../policy/types.js";
import type { SessionStore } from "../session/session-store.js";

export type MessageRole = "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ArtifactRef {
  kind: "artifact_ref";
  artifactId: string;
  mediaType: string;
  bytes: number;
  storage: "local-temp";
  path: string;
  temporary: true;
  previewText?: string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  output: unknown;
  isError?: boolean;
  artifact?: ArtifactRef;
  truncated?: boolean;
  originalBytes?: number;
}

export interface RuntimeLimits {
  maxIterations?: number;
  maxModelRequests?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
  maxConcurrentTools?: number;
}

export interface ContextBudget {
  maxMessages?: number;
  maxInputTokens?: number;
  reservedOutputTokens?: number;
  maxToolResultBytes?: number;
}

export interface ToolExecutionLimits {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CostBreakdown {
  currency: string;
  amount?: number;
  priceTableVersion?: string;
  estimated: boolean;
}

export interface RunAccounting {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelRequests: number;
  cost?: CostBreakdown;
}

export type RunTerminationReason =
  | "completed"
  | "max_iterations"
  | "max_model_requests"
  | "max_tool_calls"
  | "max_duration"
  | "context_budget_exceeded"
  | "tool_timeout"
  | "model_error"
  | "aborted";

export interface RunContext {
  runId: string;
  sessionId?: string;
  turnId: string;
  traceId: string;
  schemaVersion: string;
  sequence: number;
  startedAt: string;
  deadline?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  budget?: RuntimeLimits;
  contextBudget?: ContextBudget;
  toolLimits?: ToolExecutionLimits;
  principal?: string;
}

export interface RuntimeError {
  code:
    | "auth_error"
    | "rate_limit"
    | "quota_error"
    | "server_error"
    | "timeout"
    | "cancelled"
    | "invalid_request"
    | "context_limit"
    | "content_filter"
    | "invalid_response"
    | "network_error";
  provider?: string;
  retryable: boolean;
  status?: number;
  providerRequestId?: string;
  retryAfterMs?: number;
  message: string;
  cause?: unknown;
}

export interface ToolInvocation {
  invocationId: string;
  runId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  state: "pending" | "running" | "completed" | "failed";
  input: unknown;
  output?: unknown;
  isError?: boolean;
}

export interface Approval {
  approvalId: string;
  runId: string;
  turnId?: string;
  type: "tool_call" | "model_call";
  state: "pending" | "approved" | "denied" | "expired" | "cancelled";
}

export interface Turn {
  turnId: string;
  runId: string;
  state: "pending" | "running" | "completed" | "failed";
  sequence: number;
  startedAt: string;
  toolInvocations: ToolInvocation[];
}

export interface Run {
  runId: string;
  sessionId?: string;
  traceId: string;
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
  resolvedModel: string;
  configHash: string;
  pluginNames: string[];
  policyVersion: string;
  schemaVersion: string;
  startedAt: string;
  turns: Turn[];
}

export interface ModelOutput {
  content: string;
  toolCalls: ToolCall[];
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  refusal?: string;
  providerRequestId?: string;
  errors?: string[];
  rawProviderData?: unknown;
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolResult: ToolResult };

// A tool exposes its model-facing description and its runtime implementation.
// inputSchema intentionally stays unknown so callers may use JSON Schema or a validator.
export interface Tool {
  name: string;
  description: string;
  inputSchema: unknown;
  kind?: "generic" | "file" | "network" | "command";
  riskLevel?: "low" | "high";
  policyRootDirectory?: string;
  execute(input: unknown, context?: RunContext): Promise<unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ModelInput {
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
}

// Every model adapter implements this one method. The agent loop therefore has
// no knowledge of API keys, HTTP payloads, or a specific model provider.
export interface ModelProvider {
  generate(input: ModelInput): Promise<ModelOutput>;
}

export interface AgentLoopOptions {
  model: ModelProvider;
  modelExecutor?: {
    generate(request: { input: ModelInput; context: RunContext }): Promise<ModelOutput>;
  };
  tools?: Tool[];
  systemPrompt?: string;
  maxIterations?: number;
  runtimeLimits?: RuntimeLimits;
  contextBudget?: ContextBudget;
  toolLimits?: ToolExecutionLimits;
  signal?: AbortSignal;
  timeoutMs?: number;
  eventSink?: EventSink;
  redactor?: {
    redactValue(value: unknown): unknown;
    redactText(value: string): string;
  };
  audit?: {
    failClosedForHighRisk?: boolean;
  };
  policy?: PolicyEngine;
  approvalStore?: ApprovalStore;
  interactive?: boolean;
  principalId?: string;
  sessionId?: string;
  secretRefs?: Readonly<Record<string, SecretRef>>;
  sessionStore?: SessionStore;
  legacySessionStore?: MemoryStore<Message[]>;
}

export interface AgentLoopResult {
  content: string;
  messages: Message[];
  iterations: number;
  terminationReason: RunTerminationReason;
  usage?: RunAccounting;
}
