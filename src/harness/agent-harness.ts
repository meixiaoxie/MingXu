import { AgentSession } from "../core/agent-session.js";
import type { AgentOptions } from "../core/agent.js";
import { Agent } from "../core/agent.js";
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
import { buildSystemPrompt } from "./system-prompt.js";

export interface AgentHarnessConfig {
  model: ModelProvider;
  modelKey: string;
  streamFn?: StreamFn;
  systemPrompt?: string;
  tools?: Tool[];
  projectRoot?: string;
  sessionFilePath?: string;
  sessionId?: string;
  hooks?: AgentHooks;
  compaction?: CompactionSettings;
  maxIterations?: number;
  autoLoadClaudeMd?: boolean;
}

export class AgentHarness {
  readonly #sessionPromise: Promise<AgentSession>;
  #session: AgentSession | undefined;
  #sessionStore: JsonlSessionStoreInterface | undefined = undefined;
  #memoryManager: MemoryManager | undefined = undefined;
  readonly #config: AgentHarnessConfig;

  constructor(config: AgentHarnessConfig) {
    this.#config = config;

    if (config.sessionFilePath) {
      this.#sessionStore = new JsonlSessionStore(config.sessionFilePath);
    }

    if (config.projectRoot && config.autoLoadClaudeMd !== false) {
      this.#memoryManager = new FileMemoryStore();
      (this.#memoryManager as FileMemoryStore).addScope("project", config.projectRoot);
    }

    this.#sessionPromise = this.#createSession();
  }

  async #createSession(): Promise<AgentSession> {
    const systemPrompt = await buildSystemPrompt({
      ...(this.#config.systemPrompt !== undefined ? { baseSystemPrompt: this.#config.systemPrompt } : {}),
      ...(this.#config.projectRoot !== undefined ? { projectRoot: this.#config.projectRoot } : {}),
      ...(this.#config.autoLoadClaudeMd !== undefined ? { autoLoadClaudeMd: this.#config.autoLoadClaudeMd } : {}),
    });

    const agentOptions: AgentOptions = {
      model: this.#config.model,
      modelKey: this.#config.modelKey,
      systemPrompt,
      compaction: this.#config.compaction ?? DEFAULT_COMPACTION_SETTINGS,
      ...(this.#config.maxIterations !== undefined ? { maxIterations: this.#config.maxIterations } : {}),
      ...(this.#config.hooks !== undefined ? { hooks: this.#config.hooks } : {}),
      ...(this.#sessionStore !== undefined ? { sessionStore: this.#sessionStore } : {}),
      ...(this.#config.sessionId !== undefined ? { sessionId: this.#config.sessionId } : {}),
      ...(this.#memoryManager !== undefined ? { memoryManager: this.#memoryManager } : {}),
      ...(this.#config.streamFn !== undefined ? { streamFn: this.#config.streamFn } : {}),
      ...(this.#config.tools !== undefined ? { tools: this.#config.tools } : {}),
    };

    this.#session = new AgentSession(agentOptions);
    return this.#session;
  }

  async #getSession(): Promise<AgentSession> {
    return this.#session ?? await this.#sessionPromise;
  }

  get agent(): Agent {
    if (!this.#session) {
      throw new Error("AgentHarness is not ready yet; await prompt() first.");
    }
    return this.#session.agent;
  }

  get state() {
    if (!this.#session) {
      throw new Error("AgentHarness is not ready yet; await prompt() first.");
    }
    return this.#session.state;
  }

  get sessionStore(): JsonlSessionStoreInterface | undefined {
    return this.#sessionStore;
  }

  get memoryManager(): MemoryManager | undefined {
    return this.#memoryManager;
  }

  async subscribe(listener: Parameters<Agent["subscribe"]>[0]): Promise<() => void> {
    const session = await this.#getSession();
    return session.subscribe(listener);
  }

  async prompt(input: string): Promise<AgentLoopResult> {
    const session = await this.#getSession();
    return session.prompt(input);
  }

  async continue(): Promise<AgentLoopResult> {
    const session = await this.#getSession();
    return session.continue();
  }

  async abort(reason?: string): Promise<void> {
    const session = await this.#getSession();
    session.abort(reason);
  }

  async steer(message: string): Promise<void> {
    const session = await this.#getSession();
    session.steer(message);
  }

  async followUp(message: string): Promise<void> {
    const session = await this.#getSession();
    session.followUp(message);
  }

  async retry(): Promise<AgentLoopResult> {
    const session = await this.#getSession();
    return session.retry();
  }
}
