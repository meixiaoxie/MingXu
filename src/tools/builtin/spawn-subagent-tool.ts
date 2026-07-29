import { z } from "zod";

import { defineTool, type RuntimeTool } from "../tool.js";
import type { AgentLoopResult, RunContext } from "../../core/types.js";
import type { SubagentManager } from "../../subagents/subagent-manager.js";

const spawnSubagentInputSchema = z.object({
  prompt: z.string().trim().min(1),
  preset: z.string().trim().min(1).optional(),
  depth: z.number().int().positive().optional(),
  sessionId: z.string().trim().min(1).optional(),
}).strict();

type SpawnSubagentInput = z.infer<typeof spawnSubagentInputSchema>;

export interface SpawnSubagentToolOptions {
  readonly manager: SubagentManager;
  readonly defaultPreset?: string;
}

export function createSpawnSubagentTool(
  options: SpawnSubagentToolOptions,
): RuntimeTool<SpawnSubagentInput, { content: string; terminationReason: AgentLoopResult["terminationReason"]; sessionId?: string }> {
  return defineTool({
    name: "spawn_subagent",
    description: "Spawn a governed subagent using a registered preset.",
    inputSchema: spawnSubagentInputSchema,
    riskLevel: "high",
    async execute(input, context) {
      context?.signal?.throwIfAborted();
      const prompt = input.prompt;
      const presetName = input.preset ?? options.defaultPreset;
      if (!presetName) {
        throw new Error("spawn_subagent requires a preset");
      }
      const result = await options.manager.spawn({
        prompt,
        presetName,
        ...(input.depth !== undefined ? { depth: input.depth } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(context !== undefined && isRunContext(context) ? contextIds(context) : {}),
      });
      return {
        content: result.content,
        terminationReason: result.terminationReason,
        ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
      };
    },
  });
}

function isRunContext(context: RunContext | { signal?: AbortSignal }): context is RunContext {
  return typeof (context as RunContext).runId === "string"
    && typeof (context as RunContext).turnId === "string"
    && typeof (context as RunContext).traceId === "string";
}

function contextIds(context: RunContext): { parentSessionId?: string; parentRunId?: string } {
  return {
    ...(context.sessionId !== undefined ? { parentSessionId: context.sessionId } : {}),
    ...(context.runId !== undefined ? { parentRunId: context.runId } : {}),
  };
}
