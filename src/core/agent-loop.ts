import { DEFAULT_MAX_ITERATIONS } from "./runtime-defaults.js";
import type {
  AgentLoopOptions,
  AgentLoopResult,
  AgentMessage,
  AgentState,
  Message,
  ModelInput,
  ModelOutput,
  Run,
  RunAccounting,
  RunContext,
  RunTerminationReason,
  Tool,
  ToolCall,
  ToolResult,
  Turn,
} from "./types.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type { ToolExecutorResult } from "../tools/tool-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { executeToolLifecycle } from "../tools/tool-lifecycle.js";
import {
  checkRuntimeLimit,
  createEmptyAccounting,
  createRuntimeProgress,
  mergeUsage,
  resolveRuntimeOptions,
} from "./runtime-limits.js";
import { createRuntimeEvent } from "../events/runtime-events.js";
import type { RuntimeEvent } from "../events/types.js";
import { redactText, redactValue } from "../redaction/redactor.js";
import { createAllowAllRule, createDefaultNonInteractiveAskRule, createReadFileRootRule } from "../policy/policy-defaults.js";
import { BasicPolicyEngine } from "../policy/policy-engine.js";
import { combinePolicyDecisions } from "../policy/policy-combinators.js";
import type { PolicyDecision, PolicyEngine } from "../policy/types.js";
import { InMemoryApprovalStore } from "../approval/in-memory-approval-store.js";
import { SessionRuntime } from "../session/session-runtime.js";
import { transitionTurnState } from "./runtime-state.js";
import { createRuntimeId } from "./runtime-id.js";
import { defaultTransformContext, type AgentContext } from "./context.js";
import { compactMessages } from "../context/compaction.js";
import { createOverflowRecoverySettings, isContextOverflowError } from "../context/overflow-recovery.js";

const SESSION_MESSAGES_KEY = "messages";
const RUNTIME_SCHEMA_VERSION = "0.1.0-stage-c";

interface GovernedToolResult {
  readonly message: Message;
  readonly invocation?: ToolExecutorResult["invocation"];
  readonly terminationReason?: ToolExecutorResult["terminationReason"];
}

interface RunCompletion {
  readonly reason: RunTerminationReason;
  readonly state: "succeeded" | "failed" | "cancelled" | "timed_out";
}

export async function runAgentLoop(
  userInput: string,
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const resolved = resolveRuntimeOptions({
    ...options,
    maxIterations: options.maxIterations ?? options.runtimeLimits?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
  });
  const eventSink = options.eventSink;
  const toolRegistry = new ToolRegistry(options.tools ?? []);
  const toolExecutor = new ToolExecutor(toolRegistry);
  const policy = options.policy ?? createDefaultPolicy(options);
  const approvalStore = options.approvalStore ?? new InMemoryApprovalStore();
  const sessionRuntime = options.sessionStore
    ? new SessionRuntime({
        sessionStore: options.sessionStore,
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      })
    : undefined;
  const resumedSnapshot = sessionRuntime ? await sessionRuntime.load() : undefined;
  const legacyMessages = sessionRuntime
    ? resumedSnapshot?.messages
    : await options.legacySessionStore?.get(SESSION_MESSAGES_KEY);
  const messages: Message[] = [
    ...(legacyMessages ?? options.initialMessages ?? []),
  ];
  const submittedMessage = options.continueOnly ? undefined : { role: "user" as const, content: userInput };
  if (submittedMessage) messages.push(submittedMessage);

  const progress = createRuntimeProgress();
  let usage = createEmptyAccounting();
  let eventSequence = 0;
  const runStartedAt = new Date().toISOString();
  const runId = createRuntimeId("run");
  const traceId = createRuntimeId("trace");
  const sessionId = sessionRuntime?.currentSessionId() ?? options.sessionId;
  let currentTurn = transitionTurnState(createTurn(createRunContext(
    runId,
    traceId,
    1,
    resolved.limits.maxIterations,
    options,
    sessionId,
  )), "running");
  const run = createRun(runId, traceId, sessionId, runStartedAt, options, messages.length);
  let runStarted = false;

  const runtimeContext = (iteration: number): RunContext => createRunContext(
    runId,
    traceId,
    iteration,
    resolved.limits.maxIterations,
    options,
    sessionId,
  );
  const emitRuntime = async (
    eventType: Parameters<typeof createRuntimeEvent>[0],
    payload: Record<string, unknown>,
    context: RunContext,
    source: "core" | "model" | "tool" | "memory",
  ): Promise<void> => {
    const runtimeEvent = createRuntimeEvent(eventType as never, payload as never, {
      runId: context.runId,
      ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
      ...(context.traceId !== undefined ? { traceId: context.traceId } : {}),
      sequence: ++eventSequence,
      source,
    }) as RuntimeEvent;
    await eventSink?.emit(runtimeEvent);
  };

  const finish = async (completion: RunCompletion, content: string): Promise<AgentLoopResult> => {
    currentTurn = transitionTurnState(currentTurn, completion.state === "succeeded" ? "completed" : "failed");
    if (sessionRuntime && runStarted) {
      await sessionRuntime.finishRun(runId, messages, currentTurn, {
        state: completion.state,
        terminationReason: completion.reason,
        usage,
      });
    }
    await options.legacySessionStore?.set(SESSION_MESSAGES_KEY, redactMessages(messages));
    await emitRuntime("run.end", { terminationReason: completion.reason }, runtimeContext(currentTurn.sequence), "core");
    return {
      content,
      messages,
      iterations: progress.iterations,
      terminationReason: completion.reason,
      usage,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  };

  try {
    const firstMessage = submittedMessage ?? messages.at(-1) ?? { role: "user" as const, content: "" };
    await sessionRuntime?.beginRun(run, firstMessage);
    runStarted = sessionRuntime !== undefined;
    await emitRuntime("run.start", { iteration: 1 }, runtimeContext(1), "core");
    await options.emit?.(submittedMessage
      ? { type: "turn_start", turnId: currentTurn.turnId, input: toAgentMessage(submittedMessage) }
      : { type: "turn_start", turnId: currentTurn.turnId });

    for (let iteration = 1; iteration <= resolved.limits.maxIterations; iteration += 1) {
      const context = runtimeContext(iteration);
      currentTurn = { ...currentTurn, sequence: iteration, turnId: context.turnId };
      const limitBeforeIteration = checkRuntimeLimit(progress, resolved.limits);
      if (limitBeforeIteration) {
        await emitRuntime("budget.exceeded", { reason: limitBeforeIteration }, context, "core");
        return finish({ reason: limitBeforeIteration, state: completionState(limitBeforeIteration) }, "");
      }
      progress.iterations += 1;

      let overflowRecoveryUsed = false;
      let output: ModelOutput;
      while (true) {
        const modelLimit = checkRuntimeLimit(progress, resolved.limits);
        if (modelLimit) {
          await emitRuntime("budget.exceeded", { reason: modelLimit }, context, "core");
          return finish({ reason: modelLimit, state: completionState(modelLimit) }, "");
        }
        progress.modelRequests += 1;
        try {
          output = await requestModel(messages, options, context, overflowRecoveryUsed, emitRuntime);
          break;
        } catch (error) {
          if (!overflowRecoveryUsed && options.compaction?.enabled && isContextOverflowError(error)) {
            overflowRecoveryUsed = true;
            continue;
          }
          throw error;
        }
      }
      usage = mergeUsage(usage, output.usage);

      const assistantMessage: Message = {
        role: "assistant",
        content: output.content,
        ...(output.toolCalls.length > 0 ? { toolCalls: [...output.toolCalls] } : {}),
      };
      messages.push(assistantMessage);

      if (output.toolCalls.length === 0) {
        await options.emit?.({ type: "turn_end", message: toAgentMessage(assistantMessage), toolResults: [] });
        return finish({ reason: "completed", state: "succeeded" }, output.content);
      }

      const toolResults = await executeToolCalls({
        calls: output.toolCalls,
        options,
        context,
        messages,
        registry: toolRegistry,
        executor: toolExecutor,
        policy,
        approvalStore,
        sessionRuntime,
        progress,
        limits: resolved.limits,
      });
      messages.push(...toolResults.results.map((result) => result.message));
      currentTurn.toolInvocations.push(...toolResults.results.flatMap((result) => result.invocation ? [result.invocation] : []));
      await sessionRuntime?.appendAssistantAndTools(messages, currentTurn);

      if (toolResults.terminationReason) {
        if (toolResults.terminationReason !== "tool_timeout" && toolResults.terminationReason !== "aborted") {
          await emitRuntime("budget.exceeded", { reason: toolResults.terminationReason }, context, "core");
        }
        return finish({
          reason: toolResults.terminationReason,
          state: completionState(toolResults.terminationReason),
        }, output.content);
      }
    }

    return finish({ reason: "max_iterations", state: "failed" }, "");
  } catch (error) {
    const reason = classifyTermination(error, options.signal);
    const state = completionState(reason);
    if (runStarted && sessionRuntime) {
      currentTurn = transitionTurnState(currentTurn, "failed");
      await sessionRuntime.finishRun(runId, messages, currentTurn, { state, terminationReason: reason, usage });
    }
    await emitRuntime("run.error", {
      error: redactText(error instanceof Error ? error.message : String(error)),
      terminationReason: reason,
    }, runtimeContext(currentTurn.sequence), "core");
    throw error;
  }
}

async function requestModel(
  messages: Message[],
  options: AgentLoopOptions,
  context: RunContext,
  overflowRecovery: boolean,
  emitRuntime: (
    eventType: Parameters<typeof createRuntimeEvent>[0],
    payload: Record<string, unknown>,
    context: RunContext,
    source: "core" | "model" | "tool" | "memory",
  ) => Promise<void>,
): Promise<ModelOutput> {
  const boundedMessages = applyContextBudget(messages, options.contextBudget);
  await emitRuntime("model.request.start", {
    messageCount: boundedMessages.length,
    toolCount: options.tools?.length ?? 0,
  }, context, "model");

  let output: ModelOutput;
  if (options.streamFn) {
    const agentMessages = boundedMessages.map(toAgentMessage);
    const transform = options.transformContext ?? defaultTransformContext;
    let transformed = await transform(agentMessages, options.signal ? { signal: options.signal } : undefined);
    if (options.compaction?.enabled) {
      const settings = overflowRecovery ? createOverflowRecoverySettings(options.compaction) : options.compaction;
      const compacted = await compactMessages(transformed, settings);
      transformed = compacted.messages;
    }
    output = await consumeModelStream(options, {
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      messages: transformed,
      tools: (options.tools ?? []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  } else {
    const modelInput: ModelInput = {
      messages: boundedMessages,
      ...(options.tools?.length ? { tools: options.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } : {}),
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    };
    output = options.modelExecutor
      ? await options.modelExecutor.generate({ input: modelInput, context })
      : await options.model.generate(modelInput);
  }

  await emitRuntime("model.request.end", {
    stopReason: output.stopReason ?? "none",
    usage: redactValue(output.usage ?? {}),
    toolCallCount: output.toolCalls.length,
  }, context, "model");
  return output;
}

async function consumeModelStream(options: AgentLoopOptions, context: AgentContext): Promise<ModelOutput> {
  const stream = await options.streamFn!(
    "default",
    context,
    options.signal ? { signal: options.signal } : undefined,
  );
  let message: AgentMessage | undefined;
  let content = "";
  const toolCalls: ToolCall[] = [];

  for await (const event of stream) {
    options.signal?.throwIfAborted();
    if (event.type === "start") {
      const startedMessage = createAssistantAgentMessage(event.messageId, "");
      message = startedMessage;
      await options.emit?.({ type: "message_start", message: startedMessage });
    } else if (event.type === "text_delta") {
      content += event.text;
      message = { ...(message ?? createAssistantAgentMessage(createRuntimeId("assistant"), "")), content };
      await options.emit?.({ type: "message_update", message, delta: event });
    } else if (event.type === "tool_call") {
      toolCalls.push(event.toolCall);
      message = {
        ...(message ?? createAssistantAgentMessage(createRuntimeId("assistant"), content)),
        content,
        role: "assistant",
        toolCalls: [...toolCalls],
      };
      await options.emit?.({ type: "message_update", message, delta: event });
    } else if (event.type === "error") {
      throw new Error(event.error);
    } else if (event.type === "done") {
      const done = event.message;
      const finalMessage: AgentMessage & { role: "assistant" } = {
        ...createAssistantAgentMessage(done.id || message?.id || createRuntimeId("assistant"), done.content || content),
        ...(done.role === "assistant" && done.stopReason !== undefined ? { stopReason: done.stopReason } : {}),
        ...(done.role === "assistant" && done.usage !== undefined ? { usage: done.usage } : {}),
        ...(toolCalls.length > 0
          ? { toolCalls: [...toolCalls] }
          : done.role === "assistant" && done.toolCalls?.length
            ? { toolCalls: [...done.toolCalls] }
            : {}),
      };
      await options.emit?.({ type: "message_end", message: finalMessage });
      return {
        content: finalMessage.content,
        toolCalls: finalMessage.toolCalls ?? [],
        ...(finalMessage.stopReason !== undefined ? { stopReason: finalMessage.stopReason } : {}),
        ...(finalMessage.usage !== undefined ? { usage: finalMessage.usage } : {}),
      };
    }
  }
  throw new Error("Model stream ended without a done event");
}

async function executeToolCalls(args: {
  calls: ToolCall[];
  options: AgentLoopOptions;
  context: RunContext;
  messages: Message[];
  registry: ToolRegistry;
  executor: ToolExecutor;
  policy: PolicyEngine;
  approvalStore: NonNullable<AgentLoopOptions["approvalStore"]>;
  sessionRuntime: SessionRuntime | undefined;
  progress: ReturnType<typeof createRuntimeProgress>;
  limits: ReturnType<typeof resolveRuntimeOptions>["limits"];
}): Promise<{ results: GovernedToolResult[]; terminationReason?: RunTerminationReason }> {
  const results: GovernedToolResult[] = [];
  let index = 0;

  while (index < args.calls.length) {
    const limit = checkRuntimeLimit(args.progress, args.limits);
    if (limit) return { results, terminationReason: limit };
    const call = args.calls[index]!;
    const tool = args.registry.get(call.name);
    if (!isParallelTool(tool)) {
      args.progress.toolCalls += 1;
      const result = await executeGovernedTool(call, args);
      results.push(result);
      index += 1;
      if (result.terminationReason) return { results, terminationReason: result.terminationReason };
      continue;
    }

    const batch: ToolCall[] = [];
    while (index < args.calls.length && isParallelTool(args.registry.get(args.calls[index]!.name))) {
      const batchLimit = checkRuntimeLimit(args.progress, args.limits);
      if (batchLimit) break;
      batch.push(args.calls[index]!);
      args.progress.toolCalls += 1;
      index += 1;
    }
    const batchResults = await mapWithConcurrency(
      batch,
      args.limits.maxConcurrentTools,
      (item) => executeGovernedTool(item, args),
    );
    results.push(...batchResults);
    const terminationReason = batchResults.find((result) => result.terminationReason)?.terminationReason;
    if (terminationReason) return { results, terminationReason };
  }
  return { results };
}

async function executeGovernedTool(
  call: ToolCall,
  args: Parameters<typeof executeToolCalls>[0],
): Promise<GovernedToolResult> {
  let effectiveCall = call;
  let hookDecision: PolicyDecision | undefined;
  const state = buildAgentState(args.options, args.messages, args.calls);
  if (args.options.hooks?.beforeToolCall) {
    const before = await args.options.hooks.beforeToolCall(call, state);
    if (before.behavior === "allow" && before.input !== undefined) {
      effectiveCall = { ...call, input: before.input };
    } else if (before.behavior === "deny" || before.behavior === "ask") {
      hookDecision = {
        effect: before.behavior,
        reason: before.reason ?? `Tool ${before.behavior} requested by beforeToolCall hook`,
        ruleVersion: "hook-v1",
        matchedRuleIds: ["hook.beforeToolCall"],
      };
    }
  }

  const effectivePolicy: PolicyEngine = hookDecision
    ? {
        evaluate: async (request) => combinePolicyDecisions([
          await args.policy.evaluate(request),
          hookDecision,
        ]),
      }
    : args.policy;
  let additionalContext: string | undefined;
  await args.options.emit?.({ type: "tool_execution_start", toolCall: effectiveCall });
  const lifecycle = await executeToolLifecycle({
    name: effectiveCall.name,
    input: effectiveCall.input,
    toolCallId: effectiveCall.id,
    context: args.context,
  }, {
    registry: args.registry,
    executor: args.executor,
    policy: effectivePolicy,
    approvalStore: args.approvalStore,
    ...(args.options.approvalHandler !== undefined ? { approvalHandler: args.options.approvalHandler } : {}),
    eventSink: args.options.eventSink,
    audit: args.options.audit,
    principalId: args.options.principalId,
    interactive: args.options.interactive,
    ...(args.options.hooks?.afterToolCall
      ? { transformExecution: async (execution: ToolExecutorResult) => {
          const after = await args.options.hooks!.afterToolCall!(effectiveCall, execution.toolResult, state);
          additionalContext = after?.additionalContext;
          if (after?.output === undefined) return execution;
          return {
            invocation: { ...execution.invocation, output: after.output },
            toolResult: { ...execution.toolResult, output: after.output },
          };
        } }
      : {}),
  });
  if (lifecycle.approval) {
    await args.sessionRuntime?.recordApproval(
      lifecycle.approval,
      lifecycle.approval.decision === "allow" ? "approved" : "denied",
      { runId: args.context.runId, turnId: args.context.turnId },
    );
  }
  await args.options.emit?.({ type: "tool_execution_end", toolCall: effectiveCall, result: lifecycle.toolResult });
  const content = serializeToolOutput(lifecycle.toolResult.output);
  return {
    message: {
      role: "tool",
      content: additionalContext ? `${content}\n\n[Additional context]\n${additionalContext}` : content,
      toolResult: lifecycle.toolResult,
    },
    ...(lifecycle.execution !== undefined
      ? { invocation: lifecycle.execution.invocation }
      : lifecycle.preparation !== undefined
        ? {
            invocation: {
              invocationId: `${args.context.turnId}:tool:${effectiveCall.id}`,
              runId: args.context.runId,
              turnId: args.context.turnId,
              toolCallId: effectiveCall.id,
              toolName: effectiveCall.name,
              state: "failed" as const,
              input: lifecycle.preparation.summary,
              mutationSummary: lifecycle.preparation.summary,
              output: lifecycle.toolResult.output,
              isError: true,
            },
          }
        : {}),
    ...(lifecycle.execution?.terminationReason !== undefined
      ? { terminationReason: lifecycle.execution.terminationReason }
      : {}),
  };
}

function createDefaultPolicy(options: AgentLoopOptions): BasicPolicyEngine {
  const rules = [createAllowAllRule()];
  const readFileTool = options.tools?.find((tool) => tool.name === "readFile" && tool.policyRootDirectory);
  if (readFileTool?.policyRootDirectory) rules.unshift(createReadFileRootRule(readFileTool.policyRootDirectory));
  rules.push(createDefaultNonInteractiveAskRule());
  return new BasicPolicyEngine(rules, "g-stage-v1");
}

function createRunContext(
  runId: string,
  traceId: string,
  iteration: number,
  maxIterations: number,
  options: AgentLoopOptions,
  sessionId?: string,
): RunContext {
  return {
    runId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    turnId: `${runId}:turn:1`,
    traceId,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    sequence: iteration,
    startedAt: new Date().toISOString(),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs ?? 5_000,
    budget: { maxIterations, ...options.runtimeLimits },
    ...(options.contextBudget !== undefined ? { contextBudget: options.contextBudget } : {}),
    ...(options.toolLimits !== undefined ? { toolLimits: options.toolLimits } : {}),
  };
}

function createRun(
  runId: string,
  traceId: string,
  sessionId: string | undefined,
  startedAt: string,
  options: AgentLoopOptions,
  messageCount: number,
): Run {
  return {
    runId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    traceId,
    state: "pending",
    resolvedModel: `messages:${messageCount}`,
    configHash: `system:${options.systemPrompt ?? "none"}`,
    pluginNames: [],
    policyVersion: "g-stage-v1",
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

function buildAgentState(options: AgentLoopOptions, messages: Message[], pending: ToolCall[]): AgentState {
  return {
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    model: "default",
    messages: messages.map(toAgentMessage),
    tools: (options.tools ?? []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    isStreaming: false,
    pendingToolCalls: pending,
  };
}

function toAgentMessage(message: Message): AgentMessage {
  const base = { id: createRuntimeId(message.role), content: message.content, createdAt: new Date().toISOString() };
  if (message.role === "assistant") return { ...base, role: "assistant", ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}) };
  if (message.role === "tool") return { ...base, role: "toolResult", toolResult: message.toolResult };
  return { ...base, role: "user" };
}

function createAssistantAgentMessage(id: string, content: string): AgentMessage & { role: "assistant" } {
  return { id, role: "assistant", content, createdAt: new Date().toISOString() };
}

function applyContextBudget(messages: Message[], budget?: AgentLoopOptions["contextBudget"]): Message[] {
  if (!budget?.maxMessages || messages.length <= budget.maxMessages) return [...messages];
  return messages.slice(-budget.maxMessages);
}

function completionState(reason: RunTerminationReason): RunCompletion["state"] {
  if (reason === "completed") return "succeeded";
  if (reason === "aborted") return "cancelled";
  if (reason === "max_duration" || reason === "tool_timeout") return "timed_out";
  return "failed";
}

function classifyTermination(error: unknown, signal?: AbortSignal): RunTerminationReason {
  if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return "aborted";
  if (error instanceof DOMException && error.name === "TimeoutError") return "tool_timeout";
  if (error instanceof Error && /timeout|timed out/iu.test(error.message)) return "tool_timeout";
  return "model_error";
}

function isParallelTool(tool?: Tool): boolean {
  return Boolean(tool && "executionMode" in tool && (tool as Tool & { executionMode?: string }).executionMode === "parallel");
}

async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  concurrency: number,
  operation: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await operation(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "kind" in output && (output as { kind?: unknown }).kind === "artifact_ref") {
    const artifact = output as { artifactId?: unknown; mediaType?: unknown; bytes?: unknown };
    return `[artifact stored: id=${String(artifact.artifactId ?? "unknown")}, mediaType=${String(artifact.mediaType ?? "application/octet-stream")}, bytes=${String(artifact.bytes ?? "unknown")}]`;
  }
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
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
        ...message,
        content: redactText(message.content),
        toolResult: { ...message.toolResult, output: redactValue(message.toolResult.output) },
      };
    }
    return { ...message, content: redactText(message.content) };
  });
}
