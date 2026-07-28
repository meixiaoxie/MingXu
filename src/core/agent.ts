import { runAgentLoop } from "./agent-loop.js";
import type { AgentLoopOptions, AgentLoopResult } from "./types.js";

export class Agent {
  constructor(private readonly options: AgentLoopOptions) {}

  run(userInput: string): Promise<AgentLoopResult> {
    return runAgentLoop(userInput, this.options);
  }
}
