import type { ZodType } from "zod";

import type { RunContext, Tool, ToolExecutionContext } from "../core/types.js";

/** A validated tool remains compatible with the shared, provider-neutral Tool contract. */
export interface RuntimeTool<TInput = unknown, TOutput = unknown> extends Tool {
  readonly inputSchema: ZodType<TInput>;
  /** 工具的执行模式：sequential（串行，默认）或 parallel（并行） */
  readonly executionMode?: "sequential" | "parallel";
  execute(input: unknown, context?: RunContext): Promise<TOutput>;
}

export interface RuntimeToolDefinition<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly kind?: Tool["kind"];
  readonly riskLevel?: Tool["riskLevel"];
  readonly policyRootDirectory?: Tool["policyRootDirectory"];
  /** 工具的执行模式：sequential（串行，默认）或 parallel（并行） */
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
    ...(definition.riskLevel !== undefined
      ? { riskLevel: definition.riskLevel }
      : {}),
    ...(definition.policyRootDirectory !== undefined
      ? { policyRootDirectory: definition.policyRootDirectory }
      : {}),
    ...(definition.executionMode !== undefined
      ? { executionMode: definition.executionMode }
      : {}),
    inputSchema: definition.inputSchema,
    async execute(input: unknown, context?: RunContext): Promise<TOutput> {
      const parsedInput = definition.inputSchema.parse(input);
      context?.signal?.throwIfAborted();
      // 旧 RunContext 和新 ToolExecutionContext 都传给 execute，
      // 工具自己决定用哪个
      return definition.execute(parsedInput, context);
    },
  };
}

