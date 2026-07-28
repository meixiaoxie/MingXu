export { Agent } from "./core/agent.js";
export { runAgentLoop } from "./core/agent-loop.js";
export {
  assertSingleActiveRun,
  transitionApprovalState,
  transitionRunState,
  transitionToolInvocationState,
  transitionTurnState,
} from "./core/runtime-state.js";
export type {
  AgentLoopOptions,
  AgentLoopResult,
  Approval,
  Message,
  MessageRole,
  ModelInput,
  ModelOutput,
  ModelProvider,
  Run,
  RunContext,
  ToolCall,
  ToolDefinition,
  ToolInvocation,
  ToolResult,
  Turn,
} from "./core/types.js";
export {
  AnthropicProvider,
  CustomProvider,
  GeminiProvider,
  type ModelAdapter,
  type ModelCapabilities,
  type ModelEvent,
  type ModelMessageRole,
  type ModelRequest,
  type ModelRequestMessage,
  type ModelRequestTool,
  type ModelResponse,
  type ModelToolCall,
  type ModelUsage,
  OpenAICompatibleProvider,
  ProviderRegistry,
  buildGeminiRequest,
  createRuntimeModelProvider,
  createRuntimeStreamFn,
  defaultModelCapabilities,
  loadCustomProviderModule,
  parseGeminiResponse,
  parseOpenAICompatibleResponse,
  readProviderEnv,
  registerBuiltinProviders,
  resolveCustomProviderModulePath,
  retryProviderRequest,
  selectModelProvider,
  toModelOutput,
  toModelRequest,
  toOpenAICompatibleRequest,
} from "./models/index.js";
export type {
  CustomProviderOptions,
  CustomProviderRegister,
  GeminiProviderOptions,
  LoadCustomProviderModuleOptions,
  OpenAICompatibleProviderOptions,
  ProviderDefinition,
  ProviderSelection,
} from "./models/index.js";
export {
  createReadFileTool,
  defineTool,
  echoTool,
  readFileTool,
  ToolExecutor,
  ToolRegistry,
} from "./tools/index.js";
export type {
  ReadFileToolOptions,
  RuntimeTool,
  RuntimeToolDefinition,
  Tool,
  ToolExecutionRequest,
} from "./tools/index.js";
export { FileSessionStore, InMemoryStore } from "./memory/index.js";
export type { MemoryStore } from "./memory/index.js";
export {
  FileSessionStore as VersionedFileSessionStore,
  SessionConflictError,
  SessionRuntime,
  migrateLegacySessionDocument,
  sessionMigrationRegistry,
  SESSION_SCHEMA_VERSION,
} from "./session/index.js";
export type {
  SessionApprovalRecord,
  SessionDocument,
  SessionRecord,
  SessionRunRecord,
  SessionStore,
  SessionSummary,
  SessionToolInvocationRecord,
  SessionTurnRecord,
} from "./session/index.js";
export { definePlugin, PluginLoader } from "./plugins/index.js";
export type { Plugin, PluginContext } from "./plugins/index.js";
export {
  agentConfigSchema,
  customProviderConfigSchema,
  defineAgentConfig,
  loadConfig,
  modelConfigSchema,
  providerConfigSchema,
  resolveAgentConfig,
} from "./config/index.js";
export type {
  AgentConfig,
  AgentConfigInput,
  CustomProviderConfig,
  ModelConfig,
  PluginConfig,
  ProviderConfig,
  ResolvedAgentConfig,
  ResolvedProviderConfig,
} from "./config/index.js";

// ============================================================
// 新的 runtime 类型和函数导出（Stage B+）
// ============================================================

export { runStreamingAgentLoop } from "./core/streaming-agent-loop.js";

// core 新类型
export type {
  AgentMessage,
  AgentMessageRole,
  AgentState,
  AgentTurnState,
  QueueMode,
  StreamingAgentLoopOptions,
  ToolExecutionContext,
  ToolExecutionMode,
} from "./core/types.js";

export type {
  AgentEvent,
  AgentEventListener,
  AgentEventSink,
} from "./core/events.js";

export type {
  AgentContext,
  TokenBudget,
  TransformContext,
  ConvertToLlm,
} from "./core/context.js";
export {
  defaultConvertToLlm,
  defaultTransformContext,
  SUMMARY_PREFIX,
  SUMMARY_SUFFIX,
} from "./core/context.js";

export type {
  AssistantStreamEvent,
  StreamFn,
  StreamOptions,
} from "./core/stream-types.js";

export { createGenerateFallbackStreamFn } from "./core/stream-fn.js";

// session 类型
export type {
  SessionEntry,
  SessionEntryType,
} from "./session/session-entry.js";

export type { JsonlSessionStore as JsonlSessionStoreInterface } from "./session/jsonl-session-types.js";
export { JsonlSessionStore } from "./session/jsonl-session-store.js";
export { buildSessionTree, collectMessagesFromLeaf } from "./session/session-tree.js";
export type { SessionNode, SessionTree } from "./session/session-tree.js";

// compaction 类型和函数
export type {
  CompactionSettings,
  CompactionResult,
} from "./context/compaction.js";
export {
  shouldCompact,
  findCutPoint,
  compactMessages,
  DEFAULT_COMPACTION_SETTINGS,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateContextTokens,
  getLastUsage,
  defaultSummaryGenerator,
  createModelSummaryGenerator,
  buildContextFromEntries,
  entriesToMessages,
} from "./context/index.js";
export type { SummaryGenerator } from "./context/index.js";

// memory 类型和实现
export type {
  MemoryScope,
  MemoryEntry,
  MemoryQuery,
} from "./memory/memory-scope.js";
export type { MemoryManager } from "./memory/memory-manager.js";
export { FileMemoryStore, createAutoMemoryManager } from "./memory/file-memory-store.js";

// hooks 类型
export type {
  AgentHooks,
  BeforeToolCallResult,
  AfterToolCallResult,
  SessionStartResult,
  SessionEndResult,
  PreCompactResult,
  PostCompactResult,
  UserPromptSubmitResult,
} from "./hooks/hook-types.js";

// harness 组合层
export { AgentHarness } from "./harness/index.js";
export type { AgentHarnessConfig } from "./harness/index.js";
export { buildSystemPrompt, loadClaudeMd } from "./harness/index.js";
