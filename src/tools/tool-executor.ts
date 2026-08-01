import type { PreparedToolMutation } from "@mingxu/plugin-sdk";
import type { RunContext, RunTerminationReason, Tool, ToolInvocation, ToolResult } from "../core/types.js";
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
  readonly invocationInput?: unknown;
}

export type ToolPreparationResult =
  | { readonly ok: true; readonly preparation: PreparedToolMutation }
  | { readonly ok: false; readonly execution: ToolExecutorResult };

/**
 * ToolExecutor is the single runtime entry for tool calls.
 * Stage C first uses it to normalize success and error results before later
 * stages attach approval, budget, audit, and cancellation behavior here.
 */
export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  async prepare(request: ToolExecutorRequest): Promise<ToolPreparationResult> {
    const tool = this.registry.get(request.name);
    if (!isTwoPhaseTool(tool)) {
      return {
        ok: false,
        execution: this.#failure(request, new Error(`Tool does not support prepare/commit: ${request.name}`)),
      };
    }
    const toolContext = this.#context(request);
    try {
      const preparation = await tool.prepare(resolveRequestInput(request), toolContext);
      if (!isPreparedToolMutation(preparation)) {
        throw new Error(`Tool returned an invalid preparation: ${request.name}`);
      }
      return { ok: true, preparation };
    } catch (error) {
      return { ok: false, execution: this.#failure(request, error) };
    }
  }

  async commit(request: ToolExecutorRequest, preparation: PreparedToolMutation): Promise<ToolExecutorResult> {
    const tool = this.registry.get(request.name);
    if (!isTwoPhaseTool(tool)) {
      return this.#failure(request, new Error(`Tool does not support prepare/commit: ${request.name}`));
    }
    return this.#execute(request, () => tool.commit(preparation, this.#context(request)), preparation.summary);
  }

  async execute(request: ToolExecutorRequest): Promise<ToolExecutorResult> {
    return this.#execute(request, () => this.registry.execute({
      ...request,
      input: resolveRequestInput(request),
      context: this.#context(request),
    }));
  }

  async #execute(
    request: ToolExecutorRequest,
    operation: () => Promise<unknown>,
    mutationSummary?: PreparedToolMutation["summary"],
  ): Promise<ToolExecutorResult> {
    const invocationBase = {
      invocationId: `${request.context.turnId}:tool:${request.toolCallId}`,
      runId: request.context.runId,
      turnId: request.context.turnId,
      toolCallId: request.toolCallId,
      toolName: request.name,
      input: request.invocationInput ?? resolveRequestInput(request),
      ...(mutationSummary !== undefined ? { mutationSummary } : {}),
    } satisfies Omit<ToolInvocation, "state">;

    try {
      const output = await operation();
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
      return this.#failure(request, error, invocationBase);
    }
  }

  #context(request: ToolExecutorRequest): RunContext {
    const signal = withExecutionSignal(request.context, request.timeoutMs);
    return { ...request.context, ...(signal ? { signal } : {}) };
  }

  #failure(
    request: ToolExecutorRequest,
    error: unknown,
    invocationBase = this.#invocationBase(request),
  ): ToolExecutorResult {
    const normalized = normalizeToolError(error, error instanceof DOMException && error.name === "TimeoutError");
    return {
      invocation: {
        ...invocationBase,
        state: "failed",
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

  #invocationBase(request: ToolExecutorRequest): Omit<ToolInvocation, "state"> {
    return {
      invocationId: `${request.context.turnId}:tool:${request.toolCallId}`,
      runId: request.context.runId,
      turnId: request.context.turnId,
      toolCallId: request.toolCallId,
      toolName: request.name,
      input: request.invocationInput ?? resolveRequestInput(request),
    };
  }
}

function resolveRequestInput(request: ToolExecutionRequest): unknown {
  return Object.prototype.hasOwnProperty.call(request, "input") ? request.input : request.arguments;
}

export function isTwoPhaseTool(tool: Tool | undefined): tool is Tool & Required<Pick<Tool, "prepare" | "commit">> {
  return typeof tool?.prepare === "function" && typeof tool.commit === "function";
}

function isPreparedToolMutation(value: unknown): value is PreparedToolMutation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PreparedToolMutation>;
  return candidate.protocol === "mingxu/tool-mutation-v1"
    && candidate.binding?.protocolVersion === "mingxu/tool-mutation-v1"
    && typeof candidate.binding.changeFingerprint === "string"
    && typeof candidate.summary?.diffRef === "string"
    && candidate.presentation?.kind === "diff"
    && "opaque" in candidate;
}
