import type { ZodType } from "zod";

import type { RunContext, Tool, ToolExecutionContext, ToolGovernance } from "../core/types.js";

/** A validated tool remains compatible with the shared, provider-neutral Tool contract. */
export interface RuntimeTool<TInput = unknown, TOutput = unknown> extends Tool {
  readonly inputSchema: ZodType<TInput>;
  readonly executionMode?: "sequential" | "parallel";
  execute(input: unknown, context?: RunContext): Promise<TOutput>;
}

export interface RuntimeToolDefinition<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly kind?: Tool["kind"];
  readonly riskLevel?: Tool["riskLevel"];
  readonly policyRootDirectory?: Tool["policyRootDirectory"];
  readonly governance?: ToolGovernance;
  readonly executionMode?: "sequential" | "parallel";
  readonly inputSchema: ZodType<TInput>;
  execute(
    input: TInput,
    context?: RunContext | ToolExecutionContext,
  ): TOutput | Promise<TOutput>;
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
    ...(definition.kind !== undefined ? { kind: definition.kind } : {}),
    ...(definition.riskLevel !== undefined ? { riskLevel: definition.riskLevel } : {}),
    ...(definition.policyRootDirectory !== undefined ? { policyRootDirectory: definition.policyRootDirectory } : {}),
    ...(definition.governance !== undefined ? { governance: definition.governance } : {}),
    ...(definition.executionMode !== undefined ? { executionMode: definition.executionMode } : {}),
    inputSchema: definition.inputSchema,
    async execute(input: unknown, context?: RunContext): Promise<TOutput> {
      const parsedInput = definition.inputSchema.parse(input);
      context?.signal?.throwIfAborted();
      return definition.execute(parsedInput, context);
    },
  };
}
