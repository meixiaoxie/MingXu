import { z } from "zod";

import { assertSafeIdentifier } from "../safety/path-safety.js";

export const agentPresetSchemaV1 = z.object({
  version: z.literal("v1"),
  name: z.string().min(1),
  description: z.string().min(1),
  modelKey: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).optional(),
  resources: z.array(z.string().min(1)).optional(),
  tools: z.array(z.string().min(1)).optional(),
  maxIterations: z.number().int().positive().optional(),
  runtime: z.object({
    maxConcurrentTools: z.number().int().positive().optional(),
    maxDepth: z.number().int().positive().optional(),
    maxConcurrentSubagents: z.number().int().positive().optional(),
  }).optional(),
}).strict();

export type AgentPresetV1 = z.infer<typeof agentPresetSchemaV1>;

export class AgentPresetRegistry {
  readonly #presets = new Map<string, AgentPresetV1>();

  register(preset: AgentPresetV1): this {
    assertSafeIdentifier(preset.name, "Preset name");
    if (this.#presets.has(preset.name)) {
      throw new Error(`Preset already registered: ${preset.name}`);
    }
    this.#presets.set(preset.name, validatePreset(preset));
    return this;
  }

  get(name: string): AgentPresetV1 | undefined {
    return this.#presets.get(name);
  }

  list(): AgentPresetV1[] {
    return [...this.#presets.values()];
  }
}

function validatePreset(preset: AgentPresetV1): AgentPresetV1 {
  if (preset.systemPrompt !== undefined && !preset.systemPrompt.trim()) {
    throw new Error(`Preset systemPrompt cannot be empty: ${preset.name}`);
  }
  if (preset.maxIterations !== undefined && preset.maxIterations <= 0) {
    throw new Error(`Preset maxIterations must be positive: ${preset.name}`);
  }
  return preset;
}
