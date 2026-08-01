import { randomUUID } from "node:crypto";

import type { PreparedToolMutation } from "@mingxu/plugin-sdk";
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

import { isTwoPhaseTool, type ToolExecutor, type ToolExecutorResult } from "./tool-executor.js";
import type { ToolExecutionRequest } from "./tool-registry.js";
import { ToolRegistry } from "./tool-registry.js";

export type ToolLifecycleOutcome =
  | "unknown_tool"
  | "preparation_failed"
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
  readonly preparation?: PreparedToolMutation;
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

  let preparation: PreparedToolMutation | undefined;
  if (isTwoPhaseTool(tool)) {
    await emitMutationEvent(deps, request, "tool.prepare.start", { phase: "prepare" });
    const prepared = await deps.executor.prepare({
      ...request,
      invocationInput: mutationRequestSummary(request),
      ...(request.context.timeoutMs !== undefined ? { timeoutMs: request.context.timeoutMs } : {}),
    });
    if (!prepared.ok) {
      await emitMutationEvent(deps, request, "tool.prepare.error", {
        error: prepared.execution.toolResult.output,
      });
      return {
        outcome: "preparation_failed",
        execution: prepared.execution,
        toolResult: prepared.execution.toolResult,
      };
    }
    preparation = prepared.preparation;
    await emitMutationEvent(deps, request, "tool.prepare.end", mutationAuditPayload(preparation));
  }

  const rawPolicyRequest = await buildPolicyRequest(tool, request, deps);
  const policyRequest = preparation
    ? { ...rawPolicyRequest, normalizedInput: preparation.binding }
    : rawPolicyRequest;
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
      ...(preparation !== undefined ? { preparation } : {}),
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
          ...(preparation !== undefined ? { preparation } : {}),
          toolResult: createDeniedToolResult(request.toolCallId, request.name, `Approval denied for tool: ${request.name}`),
        };
      }
      return executeApprovedTool({
        request,
        deps,
        policyRequest,
        decision,
        approval: existingApproval,
        ...(preparation !== undefined ? { preparation } : {}),
      });
    }

    if (deps.approvalHandler) {
      const prompt: ApprovalPrompt = {
        toolName: request.name,
        toolCallId: request.toolCallId,
        principalId: policyRequest.principal.id,
        requestFingerprint,
        actionKind: policyRequest.action.kind,
        resourceScope: policyRequest.resource.kind === "file"
          ? policyRequest.resource.caseNormalizedPath
          : policyRequest.resource.kind,
        ...(policyRequest.resource.kind === "file"
          ? { normalizedResource: policyRequest.resource.caseNormalizedPath }
          : {}),
        reason: decision.reason,
        input: preparation ? approvalPreview(preparation) : resolveInput(request),
        policyEffect: decision.effect,
        ...(decision.obligations !== undefined ? { policyObligations: decision.obligations } : {}),
      };
      const response = normalizeApprovalResponse(await deps.approvalHandler(prompt));
      if (response) {
        if (response.decision === "deny") {
          const approvalRecord = createApprovalRecord(requestFingerprint, policyRequest, request.name, response.decision, preparation);
          await deps.eventSink?.emit(createRuntimeEvent("approval.matched", {
            toolCallId: request.toolCallId,
            toolName: request.name,
            approvalId: approvalRecord.id,
            decision: approvalRecord.decision,
          }, createEventContext(request.context, "core")));
          await deps.eventSink?.emit(createRuntimeEvent("tool.execution_blocked", {
            toolCallId: request.toolCallId,
            toolName: request.name,
            reason: "Approval handler denied execution",
          }, createEventContext(request.context, "tool")));
          return {
            outcome: "approval_denied",
            policyRequest,
            policyDecision: decision,
            approval: approvalRecord,
            ...(preparation !== undefined ? { preparation } : {}),
            toolResult: createDeniedToolResult(request.toolCallId, request.name, `Approval denied for tool: ${request.name}`),
          };
        }

        const approvalRecord = createApprovalRecord(requestFingerprint, policyRequest, request.name, response.decision, preparation);
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
          ...(preparation !== undefined ? { preparation } : {}),
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
      ...(preparation !== undefined ? { preparation } : {}),
      toolResult: createDeniedToolResult(request.toolCallId, request.name, `Approval required for tool: ${request.name}`),
    };
  }

  return executeApprovedTool({
    request,
    deps,
    policyRequest,
    decision,
    ...(preparation !== undefined ? { preparation } : {}),
  });
}

async function executeApprovedTool(
  args: {
    request: ToolLifecycleRequest;
    deps: ToolLifecycleDependencies;
    policyRequest: PolicyRequest;
    decision: PolicyDecision;
    approval?: ApprovalRecord;
    preparation?: PreparedToolMutation;
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
    input: redactValue(args.preparation ? mutationAuditPayload(args.preparation) : resolveInput(args.request)),
  }, createEventContext(args.request.context, "tool")));

  if (args.preparation) {
    await emitMutationEvent(args.deps, args.request, "tool.commit.start", mutationAuditPayload(args.preparation));
  }
  let execution = args.preparation
    ? await args.deps.executor.commit({
        name: args.request.name,
        input: resolveInput(args.request),
        invocationInput: args.preparation.summary,
        toolCallId: args.request.toolCallId,
        context: args.request.context,
        ...(args.request.context.timeoutMs !== undefined ? { timeoutMs: args.request.context.timeoutMs } : {}),
      }, args.preparation)
    : await args.deps.executor.execute({
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
    output: redactValue(args.preparation
      ? execution.toolResult.isError
        ? { error: execution.toolResult.output, ...mutationAuditPayload(args.preparation) }
        : { result: "committed", ...mutationAuditPayload(args.preparation) }
      : execution.toolResult.output),
    isError: execution.toolResult.isError ?? false,
  }, createEventContext(args.request.context, "tool")));
  if (args.preparation) {
    await emitMutationEvent(
      args.deps,
      args.request,
      execution.toolResult.isError ? "tool.commit.error" : "tool.commit.end",
      {
        ...mutationAuditPayload(args.preparation),
        ...(execution.toolResult.isError ? { error: execution.toolResult.output } : { result: "committed" }),
      },
    );
  }

  return {
    outcome: "executed",
    policyRequest: args.policyRequest,
    policyDecision: args.decision,
    ...(args.approval !== undefined ? { approval: args.approval } : {}),
    ...(args.preparation !== undefined ? { preparation: args.preparation } : {}),
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
  policyRequest: PolicyRequest,
  toolName: string,
  decision: "allow" | "deny",
  preparation?: PreparedToolMutation,
): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    requestFingerprint,
    principalId: policyRequest.principal.id,
    actionKind: policyRequest.action.kind,
    resourceScope: policyRequest.resource.kind === "file"
      ? policyRequest.resource.caseNormalizedPath
      : toolName,
    operator: policyRequest.principal.id,
    decision,
    createdAt: now,
    ...(preparation !== undefined ? {
      mutation: {
        changeFingerprint: preparation.binding.changeFingerprint,
        baselineHash: preparation.binding.baselineHash,
        targetHash: preparation.binding.targetHash,
        normalizedPath: preparation.binding.normalizedPath,
        diffRef: preparation.summary.diffRef,
      },
    } : {}),
  };
}

function approvalPreview(preparation: PreparedToolMutation): unknown {
  return {
    binding: preparation.binding,
    summary: preparation.summary,
    presentation: preparation.presentation,
  };
}

function mutationAuditPayload(preparation: PreparedToolMutation): Record<string, unknown> {
  return {
    operation: preparation.binding.operation,
    path: preparation.binding.normalizedPath,
    baselineHash: preparation.binding.baselineHash,
    targetHash: preparation.binding.targetHash,
    changeFingerprint: preparation.binding.changeFingerprint,
    diffRef: preparation.summary.diffRef,
    beforeBytes: preparation.summary.beforeBytes,
    afterBytes: preparation.summary.afterBytes,
  };
}

function mutationRequestSummary(request: ToolLifecycleRequest): Record<string, unknown> {
  const input = resolveInput(request);
  const path = input && typeof input === "object" && "path" in input && typeof input.path === "string"
    ? input.path.slice(0, 1024)
    : undefined;
  return {
    operation: request.name,
    ...(path !== undefined ? { path } : {}),
    status: "prepare_failed",
  };
}

async function emitMutationEvent(
  deps: Pick<ToolLifecycleDependencies, "eventSink">,
  request: ToolLifecycleRequest,
  eventType: "tool.prepare.start" | "tool.prepare.end" | "tool.prepare.error" | "tool.commit.start" | "tool.commit.end" | "tool.commit.error",
  payload: Record<string, unknown>,
): Promise<void> {
  await deps.eventSink?.emit(createRuntimeEvent(eventType, {
    toolCallId: request.toolCallId,
    toolName: request.name,
    ...redactValue(payload) as Record<string, unknown>,
  }, createEventContext(request.context, "tool")));
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
