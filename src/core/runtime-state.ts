import type { Approval, Run, Turn, ToolInvocation } from "./types.js";

const RUN_TERMINAL_STATES = new Set<Run["state"]>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);
const TURN_TERMINAL_STATES = new Set<Turn["state"]>(["completed", "failed"]);
const TOOL_TERMINAL_STATES = new Set<ToolInvocation["state"]>(["completed", "failed"]);
const APPROVAL_TERMINAL_STATES = new Set<Approval["state"]>([
  "approved",
  "denied",
  "expired",
  "cancelled",
]);

/**
 * Stage C locks down the most important invariant early: a finished record
 * must never silently become running again.
 */
export function transitionRunState(run: Run, nextState: Run["state"]): Run {
  if (RUN_TERMINAL_STATES.has(run.state) && nextState === "running") {
    throw new Error(`Run cannot transition from terminal state ${run.state} back to running`);
  }
  return { ...run, state: nextState };
}

export function transitionTurnState(turn: Turn, nextState: Turn["state"]): Turn {
  if (TURN_TERMINAL_STATES.has(turn.state) && nextState === "running") {
    throw new Error(`Turn cannot transition from terminal state ${turn.state} back to running`);
  }
  return { ...turn, state: nextState };
}

export function transitionToolInvocationState(
  invocation: ToolInvocation,
  nextState: ToolInvocation["state"],
): ToolInvocation {
  if (TOOL_TERMINAL_STATES.has(invocation.state) && nextState === "running") {
    throw new Error(
      `Tool invocation cannot transition from terminal state ${invocation.state} back to running`,
    );
  }
  return { ...invocation, state: nextState };
}

export function transitionApprovalState(
  approval: Approval,
  nextState: Approval["state"],
): Approval {
  if (APPROVAL_TERMINAL_STATES.has(approval.state) && nextState === "pending") {
    throw new Error(`Approval cannot transition from terminal state ${approval.state} back to pending`);
  }
  return { ...approval, state: nextState };
}

export function assertSingleActiveRun(runs: readonly Run[]): void {
  const activeRuns = runs.filter((run) => run.state === "running" || run.state === "pending");
  if (activeRuns.length > 1) {
    throw new Error("Only one active run is allowed in a session");
  }
}
