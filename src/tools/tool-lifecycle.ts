import { randomUUID } from "node:crypto";

import { createRuntimeEvent } from "../events/runtime-events.js";
import type { ApprovalHandler, ApprovalPrompt, ApprovalRecord, ApprovalStore, ApprovalResponse } from "../approval/types.js";
import { isApprovalUsable } from "../approval/approval-matcher.js";
import type { RunContext, Tool, ToolResult } from "../core/types.js";
import type { EventSink } from "../events/event-sink.js";
import { redactValue } from "../redaction/redactor.js";
import type { PolicyDecision, PolicyEngine, PolicyRequest } from "../policy/types.js";
import { applyNonInteractiveAskFallback } from "../policy/policy-defaults.js";
import { normalizeCommandExec } from "../policy/normalizers/command-exec-normalizer.js";
import { normalizeFileAccess } from "../policy/normalizers/file-access-normalizer.js";
import { normalizeGenericToolCall } from "../policy/normalizers/tool-call-normalizer.js";
import { normalizeNetworkAccess } from "../policy/normalizers/network-access-normalizer.js";

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
  readonly approvalHandler?: ApprovalHandler;
  readonly eventSink: EventSink | undefined;
  readonly audit: {
    readonly failClosedForHighRisk?: boolean;
  } | undefined;
  readonly principalId: string | undefined;
  readonly interactive: boolean | undefined;
  readonly transformExecution?: (execution: ToolExecutorResult) => Promise<ToolExecutorResult>;
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

  if (tool.riskLevel === "high" && deps.audit?.failClosedForHighRisk && deps.eventSink?.isHealthy?.() !== true) {
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
    const requestFingerprint = buildRequestFingerprint(policyRequest);
    const existingApproval = await deps.approvalStore.findMatching(requestFingerprint, policyRequest.principal.id);
    if (isApprovalUsable(existingApproval)) {
      await deps.eventSink?.emit(createRuntimeEvent("approval.matched", {
        toolCallId: request.toolCallId,
        toolName: request.name,
        approvalId: existingApproval.id,
        decision: existingApproval.decision,
      }, createEventContext(request.context, "core")));
      if (existingApproval.decision === "deny") {
        return {
          outcome: "approval_denied",
          policyRequest,
          policyDecision: decision,
          approval: existingApproval,
          toolResult: createDeniedToolResult(request.toolCallId, request.name, `Approval denied for tool: ${request.name}`),
        };
      }
      return executeApprovedTool({
        request,
        deps,
        policyRequest,
        decision,
        approval: existingApproval,
      });
    }

    if (deps.approvalHandler) {
      const prompt: ApprovalPrompt = {
        toolName: request.name,
        toolCallId: request.toolCallId,
        principalId: policyRequest.principal.id,
        requestFingerprint,
        actionKind: policyRequest.action.kind,
        resourceScope: policyRequest.resource.kind,
        reason: decision.reason,
        input: resolveInput(request),
        policyEffect: decision.effect,
        ...(decision.obligations !== undefined ? { policyObligations: decision.obligations } : {}),
      };
      const response = normalizeApprovalResponse(await deps.approvalHandler(prompt));
      if (response) {
        if (response.decision === "deny") {
          await deps.eventSink?.emit(createRuntimeEvent("tool.execution_blocked", {
            toolCallId: request.toolCallId,
            toolName: request.name,
            reason: "Approval handler denied execution",
          }, createEventContext(request.context, "tool")));
          return {
            outcome: "approval_denied",
            policyRequest,
            policyDecision: decision,
            toolResult: createDeniedToolResult(request.toolCallId, request.name, `Approval denied for tool: ${request.name}`),
          };
        }

        const approvalRecord = createApprovalRecord(requestFingerprint, policyRequest.principal.id, request.name, response.decision);
        if (response.scope === "session") {
          await deps.approvalStore.add(approvalRecord);
        }
        await deps.eventSink?.emit(createRuntimeEvent("approval.matched", {
          toolCallId: request.toolCallId,
          toolName: request.name,
          approvalId: approvalRecord.id,
          decision: approvalRecord.decision,
        }, createEventContext(request.context, "core")));
        return executeApprovedTool({
          request,
          deps,
          policyRequest,
          decision,
          approval: approvalRecord,
        });
      }
    }

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

  return executeApprovedTool({
    request,
    deps,
    policyRequest,
    decision,
  });
}

async function executeApprovedTool(
  args: {
    request: ToolLifecycleRequest;
    deps: ToolLifecycleDependencies;
    policyRequest: PolicyRequest;
    decision: PolicyDecision;
    approval?: ApprovalRecord;
  },
): Promise<ToolLifecycleResult> {
  await args.deps.eventSink?.emit(createRuntimeEvent("tool.execution_allowed", {
    toolCallId: args.request.toolCallId,
    toolName: args.request.name,
    obligations: redactValue(args.decision.obligations ?? []),
  }, createEventContext(args.request.context, "tool")));
  await args.deps.eventSink?.emit(createRuntimeEvent("tool.call.start", {
    toolCallId: args.request.toolCallId,
    toolName: args.request.name,
    input: redactValue(resolveInput(args.request)),
  }, createEventContext(args.request.context, "tool")));

  let execution = await args.deps.executor.execute({
    name: args.request.name,
    input: resolveInput(args.request),
    toolCallId: args.request.toolCallId,
    context: args.request.context,
    ...(args.request.context.timeoutMs !== undefined ? { timeoutMs: args.request.context.timeoutMs } : {}),
  });
  if (args.deps.transformExecution) {
    execution = await args.deps.transformExecution(execution);
  }

  await args.deps.eventSink?.emit(createRuntimeEvent(execution.toolResult.isError ? "tool.call.error" : "tool.call.end", {
    toolCallId: args.request.toolCallId,
    toolName: args.request.name,
    output: redactValue(execution.toolResult.output),
    isError: execution.toolResult.isError ?? false,
  }, createEventContext(args.request.context, "tool")));

  return {
    outcome: "executed",
    policyRequest: args.policyRequest,
    policyDecision: args.decision,
    ...(args.approval !== undefined ? { approval: args.approval } : {}),
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

  const governance = tool.governance;
  if (governance?.kind === "file" && governance.rootDirectory && typeof input === "object" && input !== null) {
    const inputObject = input as Record<string, unknown>;
    const pathField = governance.pathField ?? "path";
    if (typeof inputObject[pathField] === "string") {
      return await normalizeFileAccess({
        toolName: call.name,
        rootDirectory: governance.rootDirectory,
        path: inputObject[pathField] as string,
        mode: governance.action === "write" ? "write" : "read",
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

  if (governance?.kind === "command" && typeof input === "object" && input !== null) {
    const inputObject = input as Record<string, unknown>;
    const argvField = governance.argvField ?? "argv";
    const cwdField = governance.cwdField ?? "cwd";
    const timeoutField = governance.timeoutMsField ?? "timeoutMs";
    const argv = inputObject[argvField];
    const cwd = inputObject[cwdField];
    if (Array.isArray(argv) && argv.every((item) => typeof item === "string") && typeof cwd === "string") {
      const envValue = inputObject.env;
      const envKeys = envValue && typeof envValue === "object" && !Array.isArray(envValue)
        ? Object.keys(envValue as Record<string, unknown>)
        : governance.envFields ?? [];
      return normalizeCommandExec({
        toolName: call.name,
        argv: argv as string[],
        cwd,
        ...(envKeys.length > 0 ? { envKeys: [...envKeys] } : {}),
        ...(typeof inputObject[timeoutField] === "number" ? { timeoutMs: inputObject[timeoutField] as number } : {}),
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

  if (governance?.kind === "network" && typeof input === "object" && input !== null) {
    const inputObject = input as Record<string, unknown>;
    const urlField = governance.urlField ?? "url";
    if (typeof inputObject[urlField] === "string") {
      return normalizeNetworkAccess({
        toolName: call.name,
        url: inputObject[urlField] as string,
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

function buildRequestFingerprint(request: PolicyRequest): string {
  return JSON.stringify({
    principal: request.principal,
    action: request.action,
    resource: request.resource,
    normalizedInput: request.normalizedInput,
  });
}

function createApprovalRecord(
  requestFingerprint: string,
  principalId: string,
  toolName: string,
  decision: "allow" | "deny",
): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    requestFingerprint,
    principalId,
    actionKind: "tool.call",
    resourceScope: toolName,
    operator: principalId,
    decision,
    createdAt: now,
  };
}

function normalizeApprovalResponse(response: ApprovalResponse | undefined): ApprovalResponse | undefined {
  if (!response) {
    return undefined;
  }
  return {
    decision: response.decision,
    ...(response.scope !== undefined ? { scope: response.scope } : {}),
  };
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
