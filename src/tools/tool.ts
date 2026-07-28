import type { ZodType } from "zod";

import type { Tool } from "../core/types.js";

/** A validated tool remains compatible with the shared, provider-neutral Tool contract. */
export interface RuntimeTool<TInput = unknown, TOutput = unknown> extends Tool {
  readonly inputSchema: ZodType<TInput>;
  execute(input: unknown): Promise<TOutput>;
}

export interface RuntimeToolDefinition<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  execute(input: TInput): TOutput | Promise<TOutput>;
}

/**
 * Creates a tool whose public execute method always validates untrusted model input.
 * Keeping validation here means every caller receives the same failure behavior.
 */
export function defineTool<TInput, TOutput>(
  definition: RuntimeToolDefinition<TInput, TOutput>,
): RuntimeTool<TInput, TOutput> {
  const name = definition.name.trim();
  const description = definition.description.trim();
  if (!name) {
    throw new Error("Tool name cannot be empty");
  }
  if (!description) {
    throw new Error(`Tool description cannot be empty: ${name}`);
  }

  return {
    name,
    description,
    inputSchema: definition.inputSchema,
    async execute(input: unknown): Promise<TOutput> {
      const parsedInput = definition.inputSchema.parse(input);
      return definition.execute(parsedInput);
    },
  };
}
