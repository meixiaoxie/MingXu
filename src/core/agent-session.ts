import type { AgentOptions } from "./agent.js";
import { Agent } from "./agent.js";
import type { AgentLoopResult } from "./types.js";

export interface AgentSessionOptions extends AgentOptions {
}

export class AgentSession {
  readonly #agent: Agent;
  readonly #options: AgentSessionOptions;

  constructor(options: AgentSessionOptions) {
    this.#options = options;
    this.#agent = new Agent(options);
  }

  get agent(): Agent {
    return this.#agent;
  }

  get options(): AgentSessionOptions {
    return this.#options;
  }

  get state() {
    return this.#agent.state;
  }

  subscribe(listener: Parameters<Agent["subscribe"]>[0]): () => void {
    return this.#agent.subscribe(listener);
  }

  async run(userInput: string): Promise<AgentLoopResult> {
    return this.#agent.run(userInput);
  }

  async prompt(userInput: string): Promise<AgentLoopResult> {
    return this.#agent.prompt(userInput);
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
