import { Agent } from "../core/agent.js";
import type { AgentOptions } from "../core/agent.js";
import { JsonlSessionStore } from "../session/jsonl-session-store.js";
import type { JsonlSessionStore as JsonlSessionStoreInterface } from "../session/jsonl-session-types.js";
import { FileMemoryStore } from "../memory/file-memory-store.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { AgentHooks } from "../hooks/hook-types.js";
import type { CompactionSettings } from "../context/compaction.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../context/compaction.js";
import type { StreamFn } from "../core/stream-types.js";
import type { ModelProvider, Tool } from "../core/types.js";
import type { AgentLoopResult } from "../core/types.js";
import { buildSystemPrompt, type SystemPromptInput } from "./system-prompt.js";

/**
 * AgentHarness 配置。
 *
 * harness 是"马具"的意思：把 agent 这匹"马"和 session、memory、
 * tools、hooks、compaction 这些"缰绳、鞍具"绑在一起，
 * 提供一个开箱即用的完整配置入口。
 */
export interface AgentHarnessConfig {
  /** 模型实例（旧接口，用于 generate fallback） */
  model: ModelProvider;
  /** 模型标识符 */
  modelKey: string;
  /** 流式函数入口（优先于 model.generate） */
  streamFn?: StreamFn;

  /** 系统提示词（原始，会被 harness 增强） */
  systemPrompt?: string;

  /** 工具列表 */
  tools?: Tool[];

  /** 项目根目录（用于加载 CLAUDE.md 和 session） */
  projectRoot?: string;

  /** session 文件路径 */
  sessionFilePath?: string;
  sessionId?: string;

  /** hook 集合 */
  hooks?: AgentHooks;

  /** compaction */
  compaction?: CompactionSettings;

  /** 最大循环次数 */
  maxIterations?: number;

  /** 是否自动加载 CLAUDE.md */
  autoLoadClaudeMd?: boolean;
}

/**
 * 完整 harness 组合入口。
 *
 * 做的事：
 * 1. 创建 JSONL session store
 * 2. 创建 file memory store（自动加载 CLAUDE.md）
 * 3. 组装系统提示词（原始 + CLAUDE.md + memory）
 * 4. 创建 Agent
 */
export class AgentHarness {
  readonly #agent: Agent;
  readonly #sessionStore: JsonlSessionStoreInterface | undefined;
  readonly #memoryManager: MemoryManager | undefined;
  readonly #config: AgentHarnessConfig;

  constructor(config: AgentHarnessConfig) {
    this.#config = config;

    // ---- Session ----
    if (config.sessionFilePath) {
      this.#sessionStore = new JsonlSessionStore(config.sessionFilePath);
    }

    // ---- Memory ----
    if (config.projectRoot && config.autoLoadClaudeMd !== false) {
      this.#memoryManager = new FileMemoryStore();
      (this.#memoryManager as FileMemoryStore).addScope(
        "project",
        config.projectRoot,
      );
    }

    const sysPromptOpts: SystemPromptInput = {};
    if (config.systemPrompt !== undefined) {
      sysPromptOpts.baseSystemPrompt = config.systemPrompt;
    }
    if (config.projectRoot !== undefined) {
      sysPromptOpts.projectRoot = config.projectRoot;
    }
    const enhancedSystemPrompt = buildSystemPrompt(sysPromptOpts);

    // ---- Agent ----
    const agentOptions: AgentOptions = {
      model: config.model,
      modelKey: config.modelKey,
      systemPrompt: enhancedSystemPrompt,
      compaction: config.compaction ?? DEFAULT_COMPACTION_SETTINGS,
      ...(config.maxIterations !== undefined
        ? { maxIterations: config.maxIterations }
        : {}),
      ...(config.hooks !== undefined ? { hooks: config.hooks } : {}),
      ...(this.#sessionStore !== undefined
        ? { sessionStore: this.#sessionStore }
        : {}),
      ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}),
      ...(this.#memoryManager !== undefined
        ? { memoryManager: this.#memoryManager }
        : {}),
      ...(config.streamFn !== undefined ? { streamFn: config.streamFn } : {}),
      ...(config.tools !== undefined ? { tools: config.tools } : {}),
    };

    this.#agent = new Agent(agentOptions);
  }

  get agent(): Agent {
    return this.#agent;
  }

  get state() {
    return this.#agent.state;
  }

  get sessionStore(): JsonlSessionStoreInterface | undefined {
    return this.#sessionStore;
  }

  get memoryManager(): MemoryManager | undefined {
    return this.#memoryManager;
  }

  subscribe(listener: Parameters<Agent["subscribe"]>[0]): () => void {
    return this.#agent.subscribe(listener);
  }

  async prompt(input: string): Promise<AgentLoopResult> {
    return this.#agent.prompt(input);
  }

  async continue(): Promise<AgentLoopResult> {
    return this.#agent.continue();
  }

  abort(reason?: string): void {
    this.#agent.abort(reason);
  }

  steer(message: string): void {
    this.#agent.steer(message);
  }

  followUp(message: string): void {
    this.#agent.followUp(message);
  }

  async retry(): Promise<AgentLoopResult> {
    return this.#agent.retry();
  }
}
