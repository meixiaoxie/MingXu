import type { RunContext, RunTerminationReason, ToolInvocation, ToolResult } from "../core/types.js";
import { withExecutionSignal } from "../core/execution-signal.js";
import { normalizeToolError } from "../models/execution-errors.js";

import type { ToolExecutionRequest } from "./tool-registry.js";
import { ToolRegistry } from "./tool-registry.js";
import { encodeToolOutput } from "./tool-result-codec.js";

export interface ToolExecutorResult {
  readonly invocation: ToolInvocation;
  readonly toolResult: ToolResult;
  readonly terminationReason?: Extract<RunTerminationReason, "aborted" | "tool_timeout">;
}

export interface ToolExecutorRequest extends ToolExecutionRequest {
  readonly toolCallId: string;
  readonly context: RunContext;
  readonly timeoutMs?: number;
}

/**
 * ToolExecutor is the single runtime entry for tool calls.
 * Stage C first uses it to normalize success and error results before later
 * stages attach approval, budget, audit, and cancellation behavior here.
 */
export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(request: ToolExecutorRequest): Promise<ToolExecutorResult> {
    const invocationBase = {
      invocationId: `${request.context.turnId}:tool:${request.toolCallId}`,
      runId: request.context.runId,
      turnId: request.context.turnId,
      toolCallId: request.toolCallId,
      toolName: request.name,
      input: Object.prototype.hasOwnProperty.call(request, "input")
        ? request.input
        : request.arguments,
    } satisfies Omit<ToolInvocation, "state">;

    const signal = withExecutionSignal(request.context, request.timeoutMs);
    const toolContext: RunContext = {
      ...request.context,
      ...(signal ? { signal } : {}),
    };

    try {
      const output = await this.registry.execute({
        ...request,
        input: invocationBase.input,
        context: toolContext,
      });
      const encoded = await encodeToolOutput(output, {
        ...(request.context.toolLimits?.maxOutputBytes !== undefined
          ? { maxBytes: request.context.toolLimits.maxOutputBytes }
          : {}),
      });
      return {
        invocation: {
          ...invocationBase,
          state: "completed",
          output: encoded.output,
        },
        toolResult: {
          toolCallId: request.toolCallId,
          name: request.name,
          output: encoded.output,
          ...(encoded.truncated !== undefined ? { truncated: encoded.truncated } : {}),
          ...(encoded.originalBytes !== undefined ? { originalBytes: encoded.originalBytes } : {}),
          ...(encoded.artifact !== undefined ? { artifact: encoded.artifact } : {}),
        },
      };
    } catch (error) {
      const normalized = normalizeToolError(
        error,
        error instanceof DOMException && error.name === "TimeoutError",
      );
      return {
        invocation: {
          ...invocationBase,
          state: normalized.details.code === "timeout" ? "failed" : "failed",
          output: normalized.details.message,
          isError: true,
        },
        toolResult: {
          toolCallId: request.toolCallId,
          name: request.name,
          output: normalized.details.message,
          isError: true,
        },
        ...(normalized.details.code === "timeout"
          ? { terminationReason: "tool_timeout" as const }
          : normalized.details.code === "cancelled"
            ? { terminationReason: "aborted" as const }
            : {}),
      };
    }
  }
}
