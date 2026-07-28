import type { PolicyRequest } from "../types.js";

export interface GenericToolNormalizerInput {
  toolName: string;
  rawInput: unknown;
  principalId: string;
  interactive: boolean;
  runId: string;
  iteration: number;
  toolCallId?: string;
  sessionId?: string;
  traceId?: string;
}

export function normalizeGenericToolCall(input: GenericToolNormalizerInput): PolicyRequest {
  return {
    principal: {
      kind: "user",
      id: input.principalId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    },
    action: {
      kind: "tool.call",
      name: input.toolName,
    },
    resource: {
      kind: "tool",
      toolName: input.toolName,
    },
    normalizedInput: input.rawInput,
    runContext: {
      runId: input.runId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      interactive: input.interactive,
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      iteration: input.iteration,
    },
  };
}
