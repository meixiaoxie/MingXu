import { createGenerateFallbackStreamFn } from "./stream-fn.js";
import { ControlQueue } from "./control-queue.js";
import { runStreamingAgentLoop } from "./streaming-agent-loop.js";
import { createRuntimeId } from "./runtime-id.js";
import type {
  AgentLoopResult,
  AgentMessage,
  AgentState,
  Message,
  ModelProvider,
} from "./types.js";
import type { AgentEventListener, AgentEvent } from "../events/types.js";
import type { StreamFn } from "./stream-types.js";
import type { AgentHooks } from "../hooks/hook-types.js";
import type { TransformContext } from "./context.js";
import type { JsonlSessionStore } from "../session/jsonl-session-types.js";
import type { CompactionSettings } from "../context/compaction.js";
import type { MemoryQuery, MemoryEntry } from "../memory/memory-scope.js";

/** Agent 内用的轻量记忆管理器接口 */
export interface AgentMemoryManager {
  query(query: MemoryQuery): Promise<MemoryEntry[]>;
}

/** Agent 构造函数参数，支持额外透传字段 */
export interface AgentOptions {
  model: ModelProvider;
  modelKey?: string;
  streamFn?: StreamFn;
  systemPrompt?: string;
  tools?: import("./types.js").Tool[];
  maxIterations?: number;
  hooks?: AgentHooks;
  transformContext?: TransformContext;
  sessionStore?: JsonlSessionStore;
  sessionId?: string;
  memoryManager?: AgentMemoryManager;
  compaction?: CompactionSettings;
}

/**
 * Agent 外观类——runtime 的统一入口。
 *
 * 外部使用者不直接调 loop，而是通过 Agent 来：
 * - prompt：开始新对话
 * - continue：继续已有上下文
 * - steer：运行时纠偏
 * - followUp：追加后续任务
 * - retry：失败后重试
 * - abort：取消执行
 * - subscribe：订阅事件
 * - state：查看当前快照
 */
export class Agent {
  readonly #listeners = new Set<AgentEventListener>();
  readonly #steeringQueue = new ControlQueue<string>();
  readonly #followUpQueue = new ControlQueue<string>();
  readonly #options: AgentOptions;
  #state: AgentState;
  #abortController: AbortController | undefined;
  #lastInput: string | undefined;
  #lastStableMessages: AgentMessage[] = [];

  constructor(options: AgentOptions) {
    this.#options = options;
    this.#state = makeInitialState(options);
  }

  get state(): AgentState {
    return structuredClone(this.#state);
  }

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 兼容旧 API */
  async run(userInput: string): Promise<AgentLoopResult> {
    return this.prompt(userInput);
  }

  /** 开始新对话 */
  async prompt(userInput: string): Promise<AgentLoopResult> {
    this.#lastInput = userInput;
    this.#lastStableMessages = [...this.#state.messages];
    this.#abortController = new AbortController();

    const memoryContext = await loadMemory(this.#options.memoryManager);
    await runSessionStartHook(this.#options.hooks, this.#state, this.#state.messages);

    await emitAll(this.#listeners, { type: "agent_start", state: this.#state });

    try {
      const streamFn =
        this.#options.streamFn ??
        createGenerateFallbackStreamFn(this.#options.model);

      const allMessages = [
        ...memoryContext,
        ...this.#state.messages,
        ...this.#steeringQueue.drainAll().map(createSteeringMessage),
      ];

      const loopOpts = makeLoopOptions(
        this.#options,
        streamFn,
        allMessages,
        this.#abortController.signal,
        (event: AgentEvent) => {
          this.#state = reduceAgentState(this.#state, event);
          emitAll(this.#listeners, event);
        },
      );

      const result = await runStreamingAgentLoop({ userInput }, loopOpts);

      this.#state.messages = result.messages;
      this.#state.isStreaming = false;

      await emitAll(this.#listeners, { type: "agent_end", state: this.#state });
      await runSessionEndHook(this.#options.hooks, this.#state);

      const followUp = this.#followUpQueue.drainOne();
      if (followUp) return this.prompt(followUp);

      return toLegacyResult(result);
    } catch (error) {
      this.#state.isStreaming = false;
      this.#state.errorMessage =
        error instanceof Error ? error.message : String(error);
      await emitAll(this.#listeners, {
        type: "error",
        error: this.#state.errorMessage,
        state: this.#state,
      });
      throw error;
    } finally {
      this.#abortController = undefined;
    }
  }

  /** 继续已有上下文，不追加新用户消息 */
  async continue(): Promise<AgentLoopResult> {
    this.#lastInput = undefined;
    this.#abortController = new AbortController();

    try {
      const streamFn =
        this.#options.streamFn ??
        createGenerateFallbackStreamFn(this.#options.model);

      const loopOpts = makeLoopOptions(
        this.#options,
        streamFn,
        this.#state.messages,
        this.#abortController.signal,
        (event: AgentEvent) => {
          this.#state = reduceAgentState(this.#state, event);
          emitAll(this.#listeners, event);
        },
      );

      const result = await runStreamingAgentLoop(
        { continueOnly: true },
        loopOpts,
      );

      this.#state.messages = result.messages;
      this.#state.isStreaming = false;
      return toLegacyResult(result);
    } finally {
      this.#abortController = undefined;
    }
  }

  abort(reason = "Aborted by user"): void {
    this.#abortController?.abort(reason);
  }

  steer(message: string): void {
    this.#steeringQueue.enqueue(message);
  }

  followUp(message: string): void {
    this.#followUpQueue.enqueue(message);
  }

  async retry(): Promise<AgentLoopResult> {
    if (!this.#lastInput) {
      throw new Error("No previous prompt to retry");
    }
    this.#state.messages = [...this.#lastStableMessages];
    // 清除错误信息——retry 后是一个全新的开始
    delete this.#state.errorMessage;
    return this.prompt(this.#lastInput);
  }
}

// ============================================================
// 纯函数辅助
// ============================================================

function makeInitialState(options: AgentOptions): AgentState {
  return {
    model: options.modelKey ?? "default",
    messages: [],
    tools: (options.tools ?? []).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
    isStreaming: false,
    pendingToolCalls: [],
    ...(options.systemPrompt !== undefined
      ? { systemPrompt: options.systemPrompt }
      : {}),
  };
}

function makeLoopOptions(
  options: AgentOptions,
  streamFn: StreamFn,
  messages: AgentMessage[],
  signal: AbortSignal | undefined,
  emit: (event: AgentEvent) => void,
): import("./types.js").StreamingAgentLoopOptions {
  const result: import("./types.js").StreamingAgentLoopOptions = {
    model: options.modelKey ?? "default",
    streamFn,
    messages,
    tools: options.tools ?? [],
    maxIterations: options.maxIterations ?? 10,
    emit,
  };
  if (options.hooks !== undefined) result.hooks = options.hooks;
  if (options.transformContext !== undefined)
    result.transformContext = options.transformContext;
  if (options.sessionId !== undefined) result.sessionId = options.sessionId;
  if (options.compaction !== undefined)
    result.compaction = options.compaction;
  if (options.systemPrompt !== undefined) {
    result.systemPrompt = options.systemPrompt;
  }
  if (options.sessionStore !== undefined) {
    result.sessionStore = options.sessionStore;
  }
  if (signal !== undefined) {
    result.signal = signal;
  }
  return result;
}

async function loadMemory(
  mgr: AgentMemoryManager | undefined,
): Promise<AgentMessage[]> {
  if (!mgr) return [];
  try {
    const project = await mgr.query({ scope: "project" });
    const user = await mgr.query({ scope: "user" });
    return [...project, ...user].map((entry) => ({
      id: createRuntimeId("memory"),
      role: "system" as const,
      content: entry.content,
      createdAt: entry.updatedAt,
      visibleToModel: true,
      metadata: { source: "memory", scope: entry.scope, key: entry.key },
    }));
  } catch {
    return [];
  }
}

async function runSessionStartHook(
  hooks: AgentHooks | undefined,
  state: AgentState,
  messages: AgentMessage[],
): Promise<void> {
  if (!hooks?.onSessionStart) return;
  const hookResult = await hooks.onSessionStart(state);
  if (hookResult?.additionalContext) {
    messages.push({
      id: createRuntimeId("memory"),
      role: "system",
      content: hookResult.additionalContext,
      createdAt: new Date().toISOString(),
      visibleToModel: true,
      metadata: { source: "onSessionStart" },
    });
  }
}

async function runSessionEndHook(
  hooks: AgentHooks | undefined,
  state: AgentState,
): Promise<void> {
  if (hooks?.onSessionEnd) {
    await hooks.onSessionEnd(state);
  }
}

async function emitAll(
  listeners: Set<AgentEventListener>,
  event: AgentEvent,
): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener(event);
    } catch {
      // listener 抛错不中断其他 listener
    }
  }
}

/** 根据事件更新 AgentState，纯函数 */
export function reduceAgentState(
  state: AgentState,
  event: AgentEvent,
): AgentState {
  switch (event.type) {
    case "message_start":
      return { ...state, isStreaming: true };

    case "message_update":
      return { ...state, isStreaming: true };

    case "message_end":
      return {
        ...state,
        isStreaming: false,
        pendingToolCalls:
          event.message.role === "assistant"
            ? (event.message.toolCalls ?? [])
            : [],
      };

    case "tool_execution_start":
      return state;

    case "tool_execution_end":
      return {
        ...state,
        pendingToolCalls: state.pendingToolCalls.filter(
          (call) => call.id !== event.toolCall.id,
        ),
      };

    case "error":
      return { ...state, isStreaming: false, errorMessage: event.error };

    default:
      return state;
  }
}

// PendingMessageQueue was replaced by ControlQueue.
function createSteeringMessage(content: string): AgentMessage {
  return {
    id: createRuntimeId("steer"),
    role: "user",
    content: `[Steering instruction while agent was working]\n${content}`,
    createdAt: new Date().toISOString(),
    metadata: { kind: "steer" },
  };
}

/** 把新的 loop 结果转回旧 AgentLoopResult 格式 */
function toLegacyResult(result: {
  content: string;
  messages: AgentMessage[];
  iterations: number;
}): AgentLoopResult {
  return {
    content: result.content,
    messages: result.messages.map(agentMsgToMessage),
    iterations: result.iterations,
    terminationReason: "completed",
  };
}

function agentMsgToMessage(msg: AgentMessage): Message {
  switch (msg.role) {
    case "user":
      return { role: "user", content: msg.content };
    case "assistant": {
      const m: { role: "assistant"; content: string; toolCalls?: import("./types.js").ToolCall[] } =
        { role: "assistant", content: msg.content };
      if (msg.toolCalls?.length) m.toolCalls = msg.toolCalls;
      return m;
    }
    case "toolResult":
      return {
        role: "tool",
        content: msg.content,
        toolResult: msg.toolResult,
      };
    case "system":
    case "summary":
      return { role: "user", content: msg.content };
  }
}
