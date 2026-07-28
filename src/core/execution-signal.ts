import type { RunContext } from "../core/types.js";

export interface ExecutionSignalScope {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly deadline?: string;
}

/**
 * Combines user cancellation, run deadline, and per-operation timeout into one
 * AbortSignal so all lower layers observe the same stop condition.
 */
export function createExecutionSignal(scope: ExecutionSignalScope): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (scope.signal) {
    signals.push(scope.signal);
  }

  const timeoutSignals: AbortSignal[] = [];
  const timeoutMs = deriveTimeoutMs(scope);
  if (timeoutMs !== undefined) {
    timeoutSignals.push(AbortSignal.timeout(timeoutMs));
  }

  signals.push(...timeoutSignals);
  if (signals.length === 0) {
    return undefined;
  }
  if (signals.length === 1) {
    return signals[0];
  }
  return AbortSignal.any(signals);
}

export function withExecutionSignal(context: RunContext, timeoutMs?: number): AbortSignal | undefined {
  return createExecutionSignal({
    ...(context.signal ? { signal: context.signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(context.deadline ? { deadline: context.deadline } : {}),
  });
}

function deriveTimeoutMs(scope: ExecutionSignalScope): number | undefined {
  const candidates: number[] = [];
  if (typeof scope.timeoutMs === "number") {
    candidates.push(scope.timeoutMs);
  }
  if (scope.deadline) {
    const deadlineMs = new Date(scope.deadline).getTime() - Date.now();
    candidates.push(Math.max(0, deadlineMs));
  }
  if (candidates.length === 0) {
    return undefined;
  }
  return Math.min(...candidates);
}
