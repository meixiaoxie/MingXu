import { z } from "zod";

const modelConfigSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  apiKey: z.string().trim().min(1).optional(),
  baseUrl: z.string().url().optional(),
}).strict();

export const agentConfigSchema = z.object({
  name: z.string().trim().min(1).default("mingxu"),
  systemPrompt: z.string().optional(),
  model: modelConfigSchema,
  maxIterations: z.number().int().positive().default(10),
  sessionFile: z.string().trim().min(1).optional(),
  plugins: z.array(z.string().trim().min(1)).default([]),
}).strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentConfigInput = z.input<typeof agentConfigSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
