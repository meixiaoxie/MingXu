import { randomUUID } from "node:crypto";

import type { AgentSession } from "../core/agent-session.js";
import type { AgentLoopResult } from "../core/types.js";
import type { AgentPresetRegistry, AgentPresetV1 } from "../presets/agent-preset-registry.js";
import { assertSafeIdentifier } from "../safety/path-safety.js";

export interface SubagentSpawnRequest {
  readonly prompt: string;
  readonly presetName: string;
  readonly parentSessionId?: string;
  readonly parentRunId?: string;
  readonly depth?: number;
  readonly sessionId?: string;
}

export interface SubagentRuntimeOptions {
  readonly maxDepth?: number;
  readonly maxConcurrentSubagents?: number;
}

export interface CreateSubagentSessionRequest {
  readonly preset: AgentPresetV1;
  readonly sessionId: string;
  readonly depth: number;
  readonly parentSessionId?: string;
  readonly parentRunId?: string;
}

export interface SubagentDependencies {
  readonly presets: AgentPresetRegistry;
  readonly createSession: (request: CreateSubagentSessionRequest) => AgentSession;
}

export class SubagentManager {
  readonly #deps: SubagentDependencies;
  readonly #runtime: SubagentRuntimeOptions;
  readonly #active = new Set<string>();

  constructor(deps: SubagentDependencies, runtime: SubagentRuntimeOptions = {}) {
    this.#deps = deps;
    this.#runtime = runtime;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  async spawn(request: SubagentSpawnRequest): Promise<AgentLoopResult> {
    const preset = this.#deps.presets.get(request.presetName);
    if (!preset) {
      throw new Error(`Unknown preset: ${request.presetName}`);
    }

    const maxDepth = this.#runtime.maxDepth ?? 3;
    const depth = request.depth ?? 1;
    if (depth > maxDepth) {
      throw new Error(`Subagent depth limit exceeded: ${depth}/${maxDepth}`);
    }

    const maxConcurrent = this.#runtime.maxConcurrentSubagents ?? 4;
    if (this.#active.size >= maxConcurrent) {
      throw new Error("Subagent concurrency limit exceeded");
    }

    const sessionId = request.sessionId ?? `subagent-${randomUUID()}`;
    assertSafeIdentifier(sessionId, "Subagent session ID");

    this.#active.add(sessionId);
    try {
      const session = this.#deps.createSession({
        preset,
        sessionId,
        depth,
        ...(request.parentSessionId !== undefined ? { parentSessionId: request.parentSessionId } : {}),
        ...(request.parentRunId !== undefined ? { parentRunId: request.parentRunId } : {}),
      });
      return await session.prompt(request.prompt);
    } finally {
      this.#active.delete(sessionId);
    }
  }
}

export function filterPresetTools<T extends { name: string }>(
  preset: AgentPresetV1,
  tools: readonly T[],
): T[] {
  if (!preset.tools?.length) {
    return [...tools];
  }
  const allowed = new Set(preset.tools);
  return tools.filter((tool) => allowed.has(tool.name));
}
