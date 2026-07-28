import { DEFAULT_MAX_ITERATIONS } from "./runtime-defaults.js";
import type { AgentLoopOptions, AgentLoopResult, Message, ModelInput, Run, RunContext, Turn } from "./types.js";
import { assertSingleActiveRun, transitionRunState, transitionTurnState } from "./runtime-state.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import {
  checkRuntimeLimit,
  createEmptyAccounting,
  createRuntimeProgress,
  mergeUsage,
  resolveRuntimeOptions,
} from "./runtime-limits.js";
import { createRuntimeEvent } from "../events/runtime-events.js";
import { redactText, redactValue } from "../redaction/redactor.js";
import { normalizeFileAccess } from "../policy/normalizers/file-access-normalizer.js";
import { normalizeGenericToolCall } from "../policy/normalizers/tool-call-normalizer.js";
import { applyNonInteractiveAskFallback, createAllowAllRule, createDefaultNonInteractiveAskRule, createReadFileRootRule } from "../policy/policy-defaults.js";
import { BasicPolicyEngine } from "../policy/policy-engine.js";
import { InMemoryApprovalStore } from "../approval/in-memory-approval-store.js";
import { isApprovalUsable } from "../approval/approval-matcher.js";
import type { PolicyRequest } from "../policy/types.js";
import { SessionRuntime } from "../session/session-runtime.js";

const SESSION_MESSAGES_KEY = "messages";
const RUNTIME_SCHEMA_VERSION = "0.1.0-stage-c";

function serializeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;

  if (output && typeof output === "object" && "kind" in output && (output as { kind?: unknown }).kind === "artifact_ref") {
    const artifact = output as { artifactId?: unknown; mediaType?: unknown; bytes?: unknown };
    return `[artifact stored: id=${String(artifact.artifactId ?? "unknown")}, mediaType=${String(artifact.mediaType ?? "application/octet-stream")}, bytes=${String(artifact.bytes ?? "unknown")}]`;
  }

  try {
    const serialized = JSON.stringify(output);
    return serialized ?? String(output);
  } catch {
    return String(output);
  }
}

function createRunContext(
  runId: string,
  traceId: string,
  iteration: number,
  sessionEnabled: boolean,
  maxIterations: number,
  signal?: AbortSignal,
  timeoutMs = 5_000,
  runtimeLimits?: AgentLoopOptions["runtimeLimits"],
  contextBudget?: AgentLoopOptions["contextBudget"],
  toolLimits?: AgentLoopOptions["toolLimits"],
  sessionId?: string,
): RunContext {
  const startedAt = new Date().toISOString();
  return {
    runId,
    ...(sessionEnabled ? { sessionId: sessionId ?? "default-session" } : {}),
    turnId: `${runId}:turn:${iteration}`,
    traceId,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    sequence: iteration,
    startedAt,
    ...(signal ? { signal } : {}),
    timeoutMs,
    budget: {
      maxIterations,
      ...(runtimeLimits?.maxModelRequests !== undefined ? { maxModelRequests: runtimeLimits.maxModelRequests } : {}),
      ...(runtimeLimits?.maxToolCalls !== undefined ? { maxToolCalls: runtimeLimits.maxToolCalls } : {}),
      ...(runtimeLimits?.maxDurationMs !== undefined ? { maxDurationMs: runtimeLimits.maxDurationMs } : {}),
      ...(runtimeLimits?.maxConcurrentTools !== undefined ? { maxConcurrentTools: runtimeLimits.maxConcurrentTools } : {}),
    },
    ...(contextBudget !== undefined ? { contextBudget } : {}),
    ...(toolLimits !== undefined ? { toolLimits } : {}),
  };
}

function createRun(
  runId: string,
  traceId: string,
  sessionId: string | undefined,
  startedAt: string,
  options: AgentLoopOptions,
  modelInput: ModelInput,
): Run {
  return {
    runId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    traceId,
    state: "pending",
    resolvedModel: `messages:${modelInput.messages.length}`,
    configHash: `system:${options.systemPrompt ?? "none"}`,
    pluginNames: [],
    policyVersion: "none",
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    startedAt,
    turns: [],
  };
}

function createTurn(context: RunContext): Turn {
  return {
    turnId: context.turnId,
    runId: context.runId,
    state: "pending",
    sequence: context.sequence,
    startedAt: context.startedAt,
    toolInvocations: [],
  };
}

function applyContextBudget(messages: Message[], budget?: AgentLoopOptions["contextBudget"]): Message[] {
  if (!budget?.maxMessages || messages.length <= budget.maxMessages) {
    return messages;
  }
  return messages.slice(-budget.maxMessages);
}

function redactMessages(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        ...message,
        content: redactText(message.content),
        ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call, input: redactValue(call.input) })) } : {}),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        content: redactText(serializeToolOutput(redactValue(message.toolResult.output))),
        toolResult: {
          ...message.toolResult,
          output: redactValue(message.toolResult.output),
          ...(message.toolResult.artifact !== undefined ? { artifact: message.toolResult.artifact } : {}),
          ...(message.toolResult.truncated !== undefined ? { truncated: message.toolResult.truncated } : {}),
          ...(message.toolResult.originalBytes !== undefined ? { originalBytes: message.toolResult.originalBytes } : {}),
        },
      };
    }
    return {
      ...message,
      content: redactText(message.content),
    };
  });
}

function createEventContext(
  context: Pick<RunContext, "runId" | "sessionId" | "traceId">,
  sequence: number,
  source: "core" | "model" | "tool" | "memory",
) {
  return {
    runId: context.runId,
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context.traceId !== undefined ? { traceId: context.traceId } : {}),
    sequence,
    source,
  } as const;
}

function createDefaultPolicy(options: AgentLoopOptions): BasicPolicyEngine {
  const rules = [createAllowAllRule()];
  const readFileTool = options.tools?.find((tool) => tool.name === "readFile" && tool.policyRootDirectory);
  if (readFileTool?.policyRootDirectory) {
    rules.unshift(createReadFileRootRule(readFileTool.policyRootDirectory));
  }
  rules.push(createDefaultNonInteractiveAskRule());
  return new BasicPolicyEngine(rules, "g-stage-v1");
}

async function buildPolicyRequest(
  tool: NonNullable<ReturnType<ToolRegistry["get"]>>,
  call: { id: string; name: string; input: unknown },
  context: RunContext,
  options: AgentLoopOptions,
): Promise<PolicyRequest> {
  const principalId = options.principalId ?? "local-user";
  const interactive = options.interactive ?? false;
  if (tool.kind === "file" && tool.policyRootDirectory && typeof call.input === "object" && call.input !== null && "path" in call.input) {
    const input = call.input as { path: unknown };
    if (typeof input.path === "string") {
      return normalizeFileAccess({
        toolName: call.name,
        rootDirectory: tool.policyRootDirectory,
        path: input.path,
        mode: "read",
        principalId,
        interactive,
        runId: context.runId,
        iteration: context.sequence,
        toolCallId: call.id,
        ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
        ...(context.traceId !== undefined ? { traceId: context.traceId } : {}),
      });
    }
  }

  return normalizeGenericToolCall({
    toolName: call.name,
    rawInput: call.input,
    principalId,
    interactive,
    runId: context.runId,
    iteration: context.sequence,
    toolCallId: call.id,
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context.traceId !== undefined ? { traceId: context.traceId } : {}),
  });
}

function deniedToolResult(
  toolCallId: string,
  toolName: string,
  message: string,
) {
  return {
    role: "tool" as const,
    content: message,
    toolResult: {
      toolCallId,
      name: toolName,
      output: message,
      isError: true,
    },
  };
}

export async function runAgentLoop(
  userInput: string,
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const eventSink = options.eventSink;
  const resolved = resolveRuntimeOptions({
    ...options,
    maxIterations: options.maxIterations ?? options.runtimeLimits?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
  });
  const maxIterations = resolved.limits.maxIterations;

  const toolRegistry = new ToolRegistry(options.tools ?? []);
  const toolExecutor = new ToolExecutor(toolRegistry);
  const modelExecutor = options.modelExecutor;
  const policy = options.policy ?? createDefaultPolicy(options);
  const approvalStore = options.approvalStore ?? new InMemoryApprovalStore();
  const sessionRuntime = options.sessionStore
    ? new SessionRuntime({
        sessionStore: options.sessionStore,
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      })
    : undefined;
  const progress = createRuntimeProgress();
  let usage = createEmptyAccounting();
  const resumedSnapshot = sessionRuntime ? await sessionRuntime.load() : undefined;
  // A configured legacy store resumes the prior conversation; without one the loop
  // keeps its existing one-shot, in-memory behavior.
  const storedMessages = sessionRuntime
    ? resumedSnapshot?.messages
    : await options.legacySessionStore?.get(SESSION_MESSAGES_KEY);
  const messages: Message[] = [...(storedMessages ?? []), { role: "user", content: userInput }];
  const runStartedAt = new Date().toISOString();
  const runId = `run-${runStartedAt}-${Math.random().toString(36).slice(2, 10)}`;
  const traceId = `trace-${runStartedAt}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const limitBeforeIteration = checkRuntimeLimit(progress, resolved.limits);
      if (limitBeforeIteration) {
        await eventSink?.emit(createRuntimeEvent("budget.exceeded", {
          reason: limitBeforeIteration,
        }, {
          runId: messages.length > 0 ? `run-pending-${iteration}` : "run-pending",
          sequence: progress.iterations + progress.modelRequests + progress.toolCalls + 1,
          source: "core",
        }));
        return {
          content: "",
          messages,
          iterations: progress.iterations,
          terminationReason: limitBeforeIteration,
          usage,
        };
      }

      progress.iterations += 1;
      const context = createRunContext(
        runId,
        traceId,
        iteration,
        sessionRuntime !== undefined || options.legacySessionStore !== undefined,
        maxIterations,
        options.signal,
        options.timeoutMs,
        resolved.limits,
        resolved.contextBudget,
        resolved.toolLimits,
        sessionRuntime?.currentSessionId() ?? options.sessionId,
      );
        await eventSink?.emit(createRuntimeEvent("run.start", {
          iteration,
        }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls, "core")));
      const modelInput: ModelInput = {
        messages: applyContextBudget([...messages], resolved.contextBudget),
        ...(options.tools?.length ? { tools: options.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } : {}),
        ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      };
      const run = createRun(runId, traceId, context.sessionId, runStartedAt, options, modelInput);
      if (iteration === 1 && sessionRuntime) {
        await sessionRuntime.beginRun(run, messages.at(-1) ?? { role: "user", content: userInput });
      }
      assertSingleActiveRun([run]);
      const activeRun = transitionRunState(run, "running");
      let turn = transitionTurnState(createTurn(context), "running");
      await eventSink?.emit(createRuntimeEvent("model.request.start", {
        messageCount: modelInput.messages.length,
        toolCount: modelInput.tools?.length ?? 0,
      }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 1, "model")));
      const output = modelExecutor
        ? await modelExecutor.generate({ input: modelInput, context })
        : await options.model.generate(modelInput);
      await eventSink?.emit(createRuntimeEvent("model.request.end", {
        stopReason: output.stopReason ?? "none",
        usage: redactValue(output.usage ?? {}),
        toolCallCount: output.toolCalls.length,
      }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 2, "model")));
      progress.modelRequests += 1;
      usage = mergeUsage(usage, output.usage);
      const assistantMessage = {
        role: "assistant" as const,
        content: output.content,
        ...(output.toolCalls.length > 0 ? { toolCalls: [...output.toolCalls] } : {}),
      };
      messages.push(assistantMessage);

      if (output.toolCalls.length === 0) {
        turn = transitionTurnState(turn, "completed");
        void transitionRunState({ ...activeRun, turns: [turn] }, "succeeded");
        await eventSink?.emit(createRuntimeEvent("session.write.start", {
          messageCount: messages.length,
        }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 3, "memory")));
        if (sessionRuntime) {
          await sessionRuntime.appendAssistantAndTools(messages, turn);
          await sessionRuntime.finishRun(runId, messages, turn, {
            state: "succeeded",
            terminationReason: "completed",
            usage,
          });
        }
        // Persist only completed turns, avoiding a session file that ends halfway
        // through a tool exchange when execution fails or reaches its limit.
        await options.legacySessionStore?.set(SESSION_MESSAGES_KEY, redactMessages(messages));
        await eventSink?.emit(createRuntimeEvent("session.write.end", {
          messageCount: messages.length,
        }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 4, "memory")));
        await eventSink?.emit(createRuntimeEvent("run.end", {
          terminationReason: "completed",
        }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 5, "core")));
        return {
          content: output.content,
          messages,
          iterations: iteration,
          terminationReason: "completed",
          usage,
        };
      }

      for (const call of output.toolCalls) {
        const limitBeforeTool = checkRuntimeLimit(progress, resolved.limits);
        if (limitBeforeTool) {
          await eventSink?.emit(createRuntimeEvent("budget.exceeded", {
            reason: limitBeforeTool,
          }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 3, "core")));
          return {
            content: output.content,
            messages,
            iterations: iteration,
            terminationReason: limitBeforeTool,
            usage,
          };
        }
        const tool = toolRegistry.get(call.name);
        if (!tool) {
          messages.push(deniedToolResult(call.id, call.name, `Unknown tool: ${call.name}`));
          continue;
        }
        if (tool.riskLevel === "high" && options.audit?.failClosedForHighRisk && eventSink?.isHealthy?.() === false) {
          throw new Error(`High-risk tool requires a healthy audit sink: ${call.name}`);
        }

        const policyRequest = await buildPolicyRequest(tool, call, context, options);
        const rawDecision = await policy.evaluate(policyRequest);
        const decision = applyNonInteractiveAskFallback(policyRequest, rawDecision);
        await eventSink?.emit(createRuntimeEvent("policy.decision", {
          toolCallId: call.id,
          toolName: call.name,
          effect: decision.effect,
          reason: decision.reason,
          action: policyRequest.action,
          resource: redactValue(policyRequest.resource),
          matchedRuleIds: decision.matchedRuleIds ?? [],
        }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 3, "core")));

        if (decision.effect === "ask") {
          const requestFingerprint = JSON.stringify({
            action: policyRequest.action,
            resource: policyRequest.resource,
            normalizedInput: policyRequest.normalizedInput,
          });
          const matched = await approvalStore.findMatching(requestFingerprint);
          if (!isApprovalUsable(matched)) {
            await eventSink?.emit(createRuntimeEvent("approval.missing", {
              toolCallId: call.id,
              toolName: call.name,
              reason: decision.reason,
            }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 4, "core")));
            messages.push(deniedToolResult(call.id, call.name, `Approval required for tool: ${call.name}`));
            continue;
          }
          await eventSink?.emit(createRuntimeEvent("approval.matched", {
            toolCallId: call.id,
            toolName: call.name,
            approvalId: matched.id,
            decision: matched.decision,
          }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 4, "core")));
          await sessionRuntime?.recordApproval(matched, matched.decision === "allow" ? "approved" : "denied", {
            runId,
            turnId: context.turnId,
          });
          if (matched.decision === "deny") {
            messages.push(deniedToolResult(call.id, call.name, `Approval denied for tool: ${call.name}`));
            continue;
          }
        }

        if (decision.effect === "deny") {
          await eventSink?.emit(createRuntimeEvent("tool.execution_blocked", {
            toolCallId: call.id,
            toolName: call.name,
            reason: decision.reason,
          }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 4, "tool")));
          messages.push(deniedToolResult(call.id, call.name, `Tool denied by policy: ${decision.reason}`));
          continue;
        }

        progress.toolCalls += 1;
        await eventSink?.emit(createRuntimeEvent("tool.execution_allowed", {
          toolCallId: call.id,
          toolName: call.name,
          obligations: redactValue(decision.obligations ?? []),
        }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 4, "tool")));
        await eventSink?.emit(createRuntimeEvent("tool.call.start", {
          toolCallId: call.id,
          toolName: call.name,
          input: redactValue(call.input),
        }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 5, "tool")));
        const execution = await toolExecutor.execute({
          name: call.name,
          input: call.input,
          toolCallId: call.id,
          context,
          ...(resolved.toolLimits.timeoutMs !== undefined ? { timeoutMs: resolved.toolLimits.timeoutMs } : {}),
        });
        await eventSink?.emit(createRuntimeEvent(execution.toolResult.isError ? "tool.call.error" : "tool.call.end", {
          toolCallId: call.id,
          toolName: call.name,
          output: redactValue(execution.toolResult.output),
          isError: execution.toolResult.isError ?? false,
        }, createEventContext(context, progress.iterations + progress.modelRequests + progress.toolCalls + 6, "tool")));
        turn.toolInvocations.push(execution.invocation);
        messages.push({
          role: "tool",
          content: serializeToolOutput(execution.toolResult.output),
          toolResult: execution.toolResult,
        });
        await sessionRuntime?.appendAssistantAndTools(messages, turn);
      }
    }
  } catch (error) {
    const fallbackRunId = `run-error-${Date.now()}`;
    await eventSink?.emit(createRuntimeEvent("run.error", {
      error: redactText(error instanceof Error ? error.message : String(error)),
    }, {
      runId: fallbackRunId,
      sequence: progress.iterations + progress.modelRequests + progress.toolCalls + 1,
      source: "core",
    }));
    throw error;
  }

  return {
    content: "",
    messages,
    iterations: progress.iterations,
    terminationReason: "max_iterations",
    usage,
  };
}
