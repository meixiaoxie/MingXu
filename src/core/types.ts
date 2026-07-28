// These shared types are the small contract between the agent, models, and tools.
// Keeping them vendor-neutral lets the runtime swap Anthropic for another model later.
import type { MemoryStore } from "../memory/memory-store.js";
import type { EventSink } from "../events/event-sink.js";
import type { SecretRef } from "../redaction/secret-ref.js";
import type { ApprovalStore } from "../approval/types.js";
import type { PolicyEngine } from "../policy/types.js";
import type { SessionStore } from "../session/session-store.js";
// 从 model-protocol 导入 ModelUsage，避免重复定义
import type { ModelUsage } from "../models/model-protocol.js";

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

// ============================================================
// 以下为新的 runtime 类型（Stage B+），保留上面的旧类型不动
// ============================================================

// ---- AgentMessage：runtime 内部的统一消息格式 ----
// 旧的 Message 是模型层面用的（user/assistant/tool 三种），
// 新的 AgentMessage 比它多出 summary 和 system 两种角色，
// 还带了 id、createdAt、metadata 等额外字段。
// 这样 compaction（压缩历史）和 session（保存记录）时有更多信息可用。

export type AgentMessageRole = "user" | "assistant" | "toolResult" | "system" | "summary";

export interface AgentMessageBase {
  id: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export type AgentMessage =
  | (AgentMessageBase & { role: "user" })
  | (AgentMessageBase & {
      role: "assistant";
      toolCalls?: ToolCall[];
      stopReason?: string;
      usage?: ModelUsage;
    })
  | (AgentMessageBase & {
      role: "toolResult";
      toolResult: ToolResult;
    })
  | (AgentMessageBase & {
      role: "system";
      visibleToModel?: boolean;
    })
  | (AgentMessageBase & {
      role: "summary";
      range?: { fromId: string; toId: string };
    });

// ---- AgentState：agent 的"脑内白板" ----
// 任何时刻都可以通过 state 查看 agent 当前在干什么、有哪些消息、
// 还有哪些工具在等待执行。是 Agent 类的"快照"。

export interface AgentTurnState {
  id: string;
  startedAt: string;
  iteration: number;
}

export interface AgentState {
  systemPrompt?: string;
  model: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  isStreaming: boolean;
  pendingToolCalls: ToolCall[];
  errorMessage?: string;
  currentTurn?: AgentTurnState;
}

// ---- 控制能力 ----

/** 队列模式：all = 清空全部待处理消息，one = 只取一条 */
export type QueueMode = "all" | "one";

// ---- ToolExecutionContext ----
// 工具执行时的上下文，和旧的 RunContext 不同，这个更轻量，
// 只包含工具执行时需要的最少信息。

export interface ToolExecutionContext {
  /** 取消信号 */
  signal?: AbortSignal;
  /** 进度更新回调，工具可以随时调用它报告中间结果 */
  onUpdate?: (partialResult: unknown) => void | Promise<void>;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/** 工具的执行模式：串行（sequential）或并行（parallel） */
export type ToolExecutionMode = "sequential" | "parallel";

// ---- StreamingAgentLoopOptions ----
// 流式 Agent Loop 的完整配置。在 Stage E 中 runStreamingAgentLoop() 使用。
// 这里提前声明类型，方便后面各阶段引用。

import type { AgentEventSink } from "./events.js";
import type { TransformContext } from "./context.js";
import type { StreamFn } from "./stream-types.js";
import type { AgentHooks } from "../hooks/hook-types.js";
import type { JsonlSessionStore } from "../session/jsonl-session-types.js";
import type { CompactionSettings } from "../context/compaction.js";

export interface StreamingAgentLoopOptions {
  /** 模型标识 */
  model: string;
  /** 流式函数入口 */
  streamFn: StreamFn;
  /** 初始消息列表（可以从 session 恢复） */
  messages?: AgentMessage[];
  /** 可用工具列表 */
  tools?: Tool[];
  /** 系统提示词 */
  systemPrompt?: string;
  /** 最大循环次数 */
  maxIterations?: number;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 事件发送器 */
  emit?: AgentEventSink;
  /** 上下文转换函数 */
  transformContext?: TransformContext;
  /** hook 集合 */
  hooks?: AgentHooks;
  /** JSONL session store（每轮完成后写入） */
  sessionStore?: JsonlSessionStore;
  sessionId?: string;
  /** compaction 设置，默认不开启 */
  compaction?: CompactionSettings;
}

