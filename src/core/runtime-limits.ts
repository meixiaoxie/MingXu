import type {
  AgentLoopOptions,
  ContextBudget,
  RunAccounting,
  RunTerminationReason,
  RuntimeLimits,
  ToolExecutionLimits,
} from "./types.js";

import {
  DEFAULT_MAX_CONCURRENT_TOOLS,
  DEFAULT_MAX_MODEL_REQUESTS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  DEFAULT_TOOL_MAX_OUTPUT_BYTES,
} from "./runtime-defaults.js";

export interface ResolvedRuntimeOptions {
  readonly limits: Required<RuntimeLimits>;
  readonly contextBudget: ContextBudget;
  readonly toolLimits: ToolExecutionLimits;
}

export interface RuntimeProgress {
  iterations: number;
  modelRequests: number;
  toolCalls: number;
  startedAtMs: number;
}

export function resolveRuntimeOptions(options: AgentLoopOptions): ResolvedRuntimeOptions {
  const configuredLimits = options.runtimeLimits ?? {};
  const limits: Required<RuntimeLimits> = {
    maxIterations: options.maxIterations ?? configuredLimits.maxIterations ?? 1,
    maxModelRequests: configuredLimits.maxModelRequests ?? DEFAULT_MAX_MODEL_REQUESTS,
    maxToolCalls: configuredLimits.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    maxDurationMs: configuredLimits.maxDurationMs ?? Number.POSITIVE_INFINITY,
    maxConcurrentTools: configuredLimits.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
  };

  assertPositiveInteger(limits.maxIterations, "maxIterations");
  assertPositiveInteger(limits.maxModelRequests, "maxModelRequests");
  assertPositiveInteger(limits.maxToolCalls, "maxToolCalls");
  assertPositiveInteger(limits.maxConcurrentTools, "maxConcurrentTools");
  if (!Number.isFinite(limits.maxDurationMs) && limits.maxDurationMs !== Number.POSITIVE_INFINITY) {
    throw new Error("maxDurationMs must be a positive number when provided");
  }
  if (limits.maxDurationMs <= 0) {
    throw new Error("maxDurationMs must be a positive number");
  }

  const contextBudget: ContextBudget = {
    ...(options.contextBudget?.maxMessages !== undefined ? { maxMessages: options.contextBudget.maxMessages } : {}),
    ...(options.contextBudget?.maxInputTokens !== undefined ? { maxInputTokens: options.contextBudget.maxInputTokens } : {}),
    reservedOutputTokens: options.contextBudget?.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS,
    ...(options.contextBudget?.maxToolResultBytes !== undefined
      ? { maxToolResultBytes: options.contextBudget.maxToolResultBytes }
      : {}),
  };
  if (contextBudget.maxMessages !== undefined) assertPositiveInteger(contextBudget.maxMessages, "maxMessages");
  if (contextBudget.maxInputTokens !== undefined) assertPositiveInteger(contextBudget.maxInputTokens, "maxInputTokens");
  if (contextBudget.reservedOutputTokens !== undefined) {
    assertPositiveInteger(contextBudget.reservedOutputTokens, "reservedOutputTokens");
  }
  if (contextBudget.maxToolResultBytes !== undefined) {
    assertPositiveInteger(contextBudget.maxToolResultBytes, "maxToolResultBytes");
  }

  const toolLimits: ToolExecutionLimits = {
    ...(options.toolLimits?.timeoutMs !== undefined || options.timeoutMs !== undefined
      ? { timeoutMs: options.toolLimits?.timeoutMs ?? options.timeoutMs }
      : {}),
    maxOutputBytes: options.toolLimits?.maxOutputBytes ?? DEFAULT_TOOL_MAX_OUTPUT_BYTES,
  };
  if (toolLimits.timeoutMs !== undefined) assertPositiveInteger(toolLimits.timeoutMs, "tool timeoutMs");
  if (toolLimits.maxOutputBytes !== undefined) assertPositiveInteger(toolLimits.maxOutputBytes, "maxOutputBytes");

  return { limits, contextBudget, toolLimits };
}

export function createRuntimeProgress(): RuntimeProgress {
  return {
    iterations: 0,
    modelRequests: 0,
    toolCalls: 0,
    startedAtMs: Date.now(),
  };
}

export function checkRuntimeLimit(
  progress: RuntimeProgress,
  limits: Required<RuntimeLimits>,
): RunTerminationReason | undefined {
  if (progress.iterations >= limits.maxIterations) return "max_iterations";
  if (progress.modelRequests >= limits.maxModelRequests) return "max_model_requests";
  if (progress.toolCalls >= limits.maxToolCalls) return "max_tool_calls";
  if (Date.now() - progress.startedAtMs >= limits.maxDurationMs) return "max_duration";
  return undefined;
}

export function createEmptyAccounting(): RunAccounting {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    modelRequests: 0,
  };
}

export function mergeUsage(
  current: RunAccounting,
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): RunAccounting {
  if (!usage) {
    return {
      ...current,
      modelRequests: current.modelRequests + 1,
    };
  }
  return {
    inputTokens: current.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: current.outputTokens + (usage.outputTokens ?? 0),
    totalTokens: current.totalTokens + (usage.totalTokens ?? 0),
    cacheReadTokens: current.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: current.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    modelRequests: current.modelRequests + 1,
    ...(current.cost !== undefined ? { cost: current.cost } : {}),
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}
