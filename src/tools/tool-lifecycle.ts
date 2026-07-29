import { createRuntimeEvent } from "../events/runtime-events.js";
import type { ApprovalRecord, ApprovalStore } from "../approval/types.js";
import { isApprovalUsable } from "../approval/approval-matcher.js";
import type { RunContext, Tool, ToolResult } from "../core/types.js";
import type { EventSink } from "../events/event-sink.js";
import { redactValue } from "../redaction/redactor.js";
import type { PolicyDecision, PolicyEngine, PolicyRequest } from "../policy/types.js";
import { applyNonInteractiveAskFallback } from "../policy/policy-defaults.js";
import { normalizeFileAccess } from "../policy/normalizers/file-access-normalizer.js";
import { normalizeGenericToolCall } from "../policy/normalizers/tool-call-normalizer.js";

import type { ToolExecutor, ToolExecutorResult } from "./tool-executor.js";
import type { ToolExecutionRequest } from "./tool-registry.js";
import { ToolRegistry } from "./tool-registry.js";

export type ToolLifecycleOutcome =
  | "unknown_tool"
  | "blocked"
  | "approval_missing"
  | "approval_denied"
  | "executed";

export interface ToolLifecycleDependencies {
  readonly registry: ToolRegistry;
  readonly executor: ToolExecutor;
  readonly policy: PolicyEngine;
  readonly approvalStore: ApprovalStore;
  readonly eventSink: EventSink | undefined;
  readonly audit: {
    readonly failClosedForHighRisk?: boolean;
  } | undefined;
  readonly principalId: string | undefined;
  readonly interactive: boolean | undefined;
}

export interface ToolLifecycleResult {
  readonly outcome: ToolLifecycleOutcome;
  readonly toolResult: ToolResult;
  readonly policyRequest?: PolicyRequest;
  readonly policyDecision?: PolicyDecision;
  readonly approval?: ApprovalRecord;
  readonly execution?: ToolExecutorResult;
}

export interface ToolLifecycleRequest extends ToolExecutionRequest {
  readonly toolCallId: string;
  readonly context: RunContext;
}

export async function executeToolLifecycle(
  request: ToolLifecycleRequest,
  deps: ToolLifecycleDependencies,
): Promise<ToolLifecycleResult> {
  const tool = deps.registry.get(request.name);
  if (!tool) {
    return {
      outcome: "unknown_tool",
      toolResult: createDeniedToolResult(request.toolCallId, request.name, `Unknown tool: ${request.name}`),
    };
  }

  if (tool.riskLevel === "high" && deps.audit?.failClosedForHighRisk && deps.eventSink?.isHealthy?.() === false) {
    throw new Error(`High-risk tool requires a healthy audit sink: ${request.name}`);
  }

  const policyRequest = await buildPolicyRequest(tool, request, deps);
  const rawDecision = await deps.policy.evaluate(policyRequest);
  const decision = applyNonInteractiveAskFallback(policyRequest, rawDecision);

  await deps.eventSink?.emit(createRuntimeEvent("policy.decision", {
    toolCallId: request.toolCallId,
    toolName: request.name,
    effect: decision.effect,
    reason: decision.reason,
    action: policyRequest.action,
    resource: redactValue(policyRequest.resource),
    matchedRuleIds: decision.matchedRuleIds ?? [],
  }, createEventContext(request.context, "core")));

  if (decision.effect === "deny") {
    await deps.eventSink?.emit(createRuntimeEvent("tool.execution_blocked", {
      toolCallId: request.toolCallId,
      toolName: request.name,
      reason: decision.reason,
    }, createEventContext(request.context, "tool")));
    return {
      outcome: "blocked",
      policyRequest,
      policyDecision: decision,
      toolResult: createDeniedToolResult(request.toolCallId, request.name, `Tool denied by policy: ${decision.reason}`),
    };
  }

  if (decision.effect === "ask") {
    const requestFingerprint = JSON.stringify({
      action: policyRequest.action,
      resource: policyRequest.resource,
      normalizedInput: policyRequest.normalizedInput,
    });
    const approval = await deps.approvalStore.findMatching(requestFingerprint);
    if (!isApprovalUsable(approval)) {
      await deps.eventSink?.emit(createRuntimeEvent("approval.missing", {
        toolCallId: request.toolCallId,
        toolName: request.name,
        reason: decision.reason,
      }, createEventContext(request.context, "core")));
      return {
        outcome: "approval_missing",
        policyRequest,
        policyDecision: decision,
        toolResult: createDeniedToolResult(request.toolCallId, request.name, `Approval required for tool: ${request.name}`),
      };
    }

    await deps.eventSink?.emit(createRuntimeEvent("approval.matched", {
      toolCallId: request.toolCallId,
      toolName: request.name,
      approvalId: approval.id,
      decision: approval.decision,
    }, createEventContext(request.context, "core")));

    if (approval.decision === "deny") {
      return {
        outcome: "approval_denied",
        policyRequest,
        policyDecision: decision,
        approval,
        toolResult: createDeniedToolResult(request.toolCallId, request.name, `Approval denied for tool: ${request.name}`),
      };
    }

    await deps.eventSink?.emit(createRuntimeEvent("tool.execution_allowed", {
      toolCallId: request.toolCallId,
      toolName: request.name,
      obligations: redactValue(decision.obligations ?? []),
    }, createEventContext(request.context, "tool")));
    await deps.eventSink?.emit(createRuntimeEvent("tool.call.start", {
      toolCallId: request.toolCallId,
      toolName: request.name,
      input: redactValue(resolveInput(request)),
    }, createEventContext(request.context, "tool")));
    const execution = await deps.executor.execute({
      name: request.name,
      input: resolveInput(request),
      toolCallId: request.toolCallId,
      context: request.context,
      ...(request.context.timeoutMs !== undefined ? { timeoutMs: request.context.timeoutMs } : {}),
    });
    await deps.eventSink?.emit(createRuntimeEvent(execution.toolResult.isError ? "tool.call.error" : "tool.call.end", {
      toolCallId: request.toolCallId,
      toolName: request.name,
      output: redactValue(execution.toolResult.output),
      isError: execution.toolResult.isError ?? false,
    }, createEventContext(request.context, "tool")));
    return {
      outcome: "executed",
      policyRequest,
      policyDecision: decision,
      approval,
      execution,
      toolResult: execution.toolResult,
    };
  }

  await deps.eventSink?.emit(createRuntimeEvent("tool.execution_allowed", {
    toolCallId: request.toolCallId,
    toolName: request.name,
    obligations: redactValue(decision.obligations ?? []),
  }, createEventContext(request.context, "tool")));
  await deps.eventSink?.emit(createRuntimeEvent("tool.call.start", {
    toolCallId: request.toolCallId,
    toolName: request.name,
    input: redactValue(resolveInput(request)),
  }, createEventContext(request.context, "tool")));
  const execution = await deps.executor.execute({
    name: request.name,
    input: resolveInput(request),
    toolCallId: request.toolCallId,
    context: request.context,
    ...(request.context.timeoutMs !== undefined ? { timeoutMs: request.context.timeoutMs } : {}),
  });
  await deps.eventSink?.emit(createRuntimeEvent(execution.toolResult.isError ? "tool.call.error" : "tool.call.end", {
    toolCallId: request.toolCallId,
    toolName: request.name,
    output: redactValue(execution.toolResult.output),
    isError: execution.toolResult.isError ?? false,
  }, createEventContext(request.context, "tool")));
  return {
    outcome: "executed",
    policyRequest,
    policyDecision: decision,
    execution,
    toolResult: execution.toolResult,
  };
}

async function buildPolicyRequest(
  tool: Tool,
  call: ToolLifecycleRequest,
  deps: Pick<ToolLifecycleDependencies, "principalId" | "interactive">,
): Promise<PolicyRequest> {
  const principalId = deps.principalId ?? "local-user";
  const interactive = deps.interactive ?? false;
  const input = resolveInput(call);

  if (tool.kind === "file" && tool.policyRootDirectory && typeof input === "object" && input !== null && "path" in input) {
    const fileInput = input as { path: unknown };
    if (typeof fileInput.path === "string") {
      return await normalizeFileAccess({
        toolName: call.name,
        rootDirectory: tool.policyRootDirectory,
        path: fileInput.path,
        mode: "read",
        principalId,
        interactive,
        runId: call.context.runId,
        iteration: call.context.sequence,
        toolCallId: call.toolCallId,
        ...(call.context.sessionId !== undefined ? { sessionId: call.context.sessionId } : {}),
        ...(call.context.traceId !== undefined ? { traceId: call.context.traceId } : {}),
      });
    }
  }

  return normalizeGenericToolCall({
    toolName: call.name,
    rawInput: input,
    principalId,
    interactive,
    runId: call.context.runId,
    iteration: call.context.sequence,
    toolCallId: call.toolCallId,
    ...(call.context.sessionId !== undefined ? { sessionId: call.context.sessionId } : {}),
    ...(call.context.traceId !== undefined ? { traceId: call.context.traceId } : {}),
  });
}

function resolveInput(request: ToolExecutionRequest): unknown {
  if (Object.prototype.hasOwnProperty.call(request, "input")) {
    return request.input;
  }
  return request.arguments;
}

function createEventContext(
  context: Pick<RunContext, "runId" | "sessionId" | "traceId" | "sequence">,
  source: "core" | "tool",
) {
  return {
    runId: context.runId,
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context.traceId !== undefined ? { traceId: context.traceId } : {}),
    sequence: context.sequence,
    source,
  } as const;
}

function createDeniedToolResult(
  toolCallId: string,
  toolName: string,
  message: string,
): ToolResult {
  return {
    toolCallId,
    name: toolName,
    output: message,
    isError: true,
  };
}
