import type { PolicyRequest } from "../types.js";

export interface CommandExecNormalizerInput {
  toolName: string;
  argv: string[];
  cwd: string;
  envKeys?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  principalId: string;
  interactive: boolean;
  runId: string;
  iteration: number;
  toolCallId?: string;
  sessionId?: string;
  traceId?: string;
}

export function normalizeCommandExec(input: CommandExecNormalizerInput): PolicyRequest {
  return {
    principal: {
      kind: "user",
      id: input.principalId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    },
    action: {
      kind: "command.exec",
      name: input.toolName,
      mode: "exec",
    },
    resource: {
      kind: "command",
      argv: input.argv,
      cwd: input.cwd,
      envKeys: input.envKeys ?? [],
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
    },
    normalizedInput: {
      argv: input.argv,
      cwd: input.cwd,
      envKeys: input.envKeys ?? [],
    },
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
