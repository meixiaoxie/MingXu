import { DEFAULT_MAX_ITERATIONS } from "./runtime-defaults.js";
import type { AgentMessage, AgentState, StreamingAgentLoopOptions, Tool, ToolCall, ToolResult } from "./types.js";
import { createRuntimeId } from "./runtime-id.js";
import { defaultTransformContext } from "./context.js";
import type { AgentContext, TransformContext } from "./context.js";
import type { AgentEventSink } from "./events.js";
import type { StreamFn } from "./stream-types.js";
import type { AgentHooks } from "../hooks/hook-types.js";
import { compactMessages } from "../context/compaction.js";
import { createOverflowRecoverySettings, isContextOverflowError } from "../context/overflow-recovery.js";

const noopEmit: AgentEventSink = () => {};

export async function runStreamingAgentLoop(
  input: { userInput?: string; continueOnly?: boolean },
  options: StreamingAgentLoopOptions,
) {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error("maxIterations must be a positive integer");
  }

  const emit = options.emit ?? noopEmit;
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  const messages: AgentMessage[] = [...(options.messages ?? [])];
  const userMessage =
    input.userInput && !input.continueOnly
      ? createUserAgentMessage(input.userInput)
      : undefined;

  if (userMessage) {
    if (options.hooks?.onUserPromptSubmit) {
      const hookResult = await options.hooks.onUserPromptSubmit(
        input.userInput!,
        buildAgentState(options, messages),
      );
      if (hookResult?.updatedPrompt) {
        userMessage.content = hookResult.updatedPrompt;
      }
    }
    messages.push(userMessage);
  }

  await emit(userMessage
    ? { type: "turn_start", turnId: createRuntimeId("turn"), input: userMessage }
    : { type: "turn_start", turnId: createRuntimeId("turn") });

  let overflowRecoveryUsed = false;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    throwIfAborted(options.signal);

    const transformFn: TransformContext = options.transformContext ?? defaultTransformContext;
    const transformOpts = options.signal ? { signal: options.signal } : undefined;
    const compactionEnabled = options.compaction?.enabled ?? false;
    const compactionSettings = overflowRecoveryUsed && options.compaction
      ? createOverflowRecoverySettings(options.compaction)
      : options.compaction;

    const transformedMessages = compactionEnabled
      ? await transformWithCompaction(messages, transformFn, transformOpts, compactionSettings)
      : await transformFn(messages, transformOpts);

    const context: AgentContext = {
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      messages: transformedMessages,
      tools: (options.tools ?? []).map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    };

    try {
      const assistant = await streamAssistantMessage({
        context,
        model: options.model,
        streamFn: options.streamFn,
        emit,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });

      messages.push(assistant);
      await appendToSession(options, assistant);

      if (!assistant.toolCalls?.length) {
        await emit({ type: "turn_end", message: assistant, toolResults: [] });
        return { content: assistant.content, messages, iterations: iteration };
      }

      const parallelToolCalls: Promise<void>[] = [];
      for (const call of assistant.toolCalls) {
        const tool = tools.get(call.name);
        const execArgs = {
          call,
          emit,
          hooks: options.hooks,
          state: buildAgentState(options, messages),
        } as Parameters<typeof executeToolCallWithHooks>[0];

        if (options.signal !== undefined) execArgs.signal = options.signal;
        if (tool) execArgs.tool = tool;

        const executor = executeToolCallWithHooks(execArgs).then((toolResultMessage) => {
          messages.push(toolResultMessage);
        });

        if (isParallelTool(tool)) {
          parallelToolCalls.push(executor);
        } else {
          await executor;
        }
      }
      await Promise.all(parallelToolCalls);
    } catch (error) {
      if (compactionEnabled && !overflowRecoveryUsed && isContextOverflowError(error)) {
        const recovered = await retryAfterCompaction({ messages, options });
        if (recovered) {
          overflowRecoveryUsed = true;
          continue;
        }
      }
      throw error;
    }
  }

  throw new Error(`Agent loop reached the maximum of ${maxIterations} iterations`);
}

function isParallelTool(tool?: Tool): boolean {
  if (!tool) return false;
  return "executionMode" in tool && (tool as Tool & { executionMode: string }).executionMode === "parallel";
}

async function streamAssistantMessage(args: {
  context: AgentContext;
  model: string;
  streamFn: StreamFn;
  emit: AgentEventSink;
  signal?: AbortSignal;
}): Promise<AgentMessage & { role: "assistant" }> {
  let message: (AgentMessage & { role: "assistant" }) | undefined;
  let content = "";
  const toolCalls: ToolCall[] = [];

  const stream = await args.streamFn(
    args.model,
    args.context,
    args.signal !== undefined ? { signal: args.signal } : undefined,
  );

  for await (const event of stream) {
    throwIfAborted(args.signal);

    switch (event.type) {
      case "start": {
        const newMsg = createAssistantMessage({ id: event.messageId, content: "" });
        message = newMsg;
        await args.emit({ type: "message_start", message: newMsg });
        break;
      }
      case "text_delta": {
        content += event.text;
        const updated = updateAssistantMessage(message, { content });
        message = updated;
        await args.emit({ type: "message_update", message: updated, delta: event });
        break;
      }
      case "tool_call": {
        toolCalls.push(event.toolCall);
        const updated = updateAssistantMessage(message, { content, toolCalls: [...toolCalls] });
        message = updated;
        await args.emit({ type: "message_update", message: updated, delta: event });
        break;
      }
      case "done": {
        const finalMessage: AgentMessage & { role: "assistant" } = {
          ...event.message,
          id: event.message.id || message?.id || createRuntimeId("assistant"),
          content: event.message.content || content,
          ...(toolCalls.length ? { toolCalls } : {}),
          role: "assistant",
        };
        await args.emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
      case "error": {
        throw new Error(event.error);
      }
    }
  }

  throw new Error("Model stream ended without a done event");
}

async function executeToolCallWithHooks(args: {
  call: ToolCall;
  tool?: Tool;
  emit: AgentEventSink;
  signal?: AbortSignal;
  hooks?: AgentHooks;
  state: AgentState;
}): Promise<AgentMessage & { role: "toolResult" }> {
  let effectiveArgs = args;
  if (effectiveArgs.hooks?.beforeToolCall) {
    const before = await effectiveArgs.hooks.beforeToolCall(effectiveArgs.call, effectiveArgs.state);
    if (before.behavior === "deny") {
      const deniedResult: ToolResult = {
        toolCallId: effectiveArgs.call.id,
        name: effectiveArgs.call.name,
        output: `Tool execution denied: ${before.reason}`,
        isError: true,
      };
      await effectiveArgs.emit({ type: "tool_execution_end", toolCall: effectiveArgs.call, result: deniedResult });
      return createToolResultMessage(deniedResult);
    }
    if (before.behavior === "allow" && before.input !== undefined) {
      effectiveArgs = { ...effectiveArgs, call: { ...effectiveArgs.call, input: before.input } };
    }
  }

  await effectiveArgs.emit({ type: "tool_execution_start", toolCall: effectiveArgs.call });
  const rawResult = await executeToolCall(effectiveArgs.call, effectiveArgs.tool, effectiveArgs.signal);
  let result = rawResult;

  if (effectiveArgs.hooks?.afterToolCall) {
    const after = await effectiveArgs.hooks.afterToolCall(effectiveArgs.call, result, effectiveArgs.state);
    if (after?.output !== undefined) {
      result = { ...result, output: after.output };
    }
  }

  await effectiveArgs.emit({ type: "tool_execution_end", toolCall: effectiveArgs.call, result });

  const toolResultMessage = createToolResultMessage(result);
  if (effectiveArgs.hooks?.afterToolCall) {
    const after = await effectiveArgs.hooks.afterToolCall(effectiveArgs.call, result, effectiveArgs.state);
    if (after?.additionalContext) {
      toolResultMessage.metadata = {
        ...toolResultMessage.metadata,
        additionalContext: after.additionalContext,
      };
    }
  }

  return toolResultMessage;
}

async function executeToolCall(
  call: ToolCall,
  tool: Tool | undefined,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (!tool) {
    return {
      toolCallId: call.id,
      name: call.name,
      output: `Unknown tool: ${call.name}`,
      isError: true,
    };
  }

  try {
    const output = await tool.execute(call.input);
    return {
      toolCallId: call.id,
      name: call.name,
      output,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw new Error("Agent loop was aborted");
    }
    return {
      toolCallId: call.id,
      name: call.name,
      output: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

function createUserAgentMessage(content: string): AgentMessage & { role: "user" } {
  return {
    id: createRuntimeId("user"),
    role: "user",
    content,
    createdAt: new Date().toISOString(),
  };
}

function createAssistantMessage(partial: { id?: string; content: string; createdAt?: string }): AgentMessage & { role: "assistant" } {
  return {
    id: partial.id ?? createRuntimeId("assistant"),
    role: "assistant",
    content: partial.content,
    createdAt: partial.createdAt ?? new Date().toISOString(),
  };
}

function updateAssistantMessage(
  existing: (AgentMessage & { role: "assistant" }) | undefined,
  updates: Partial<AgentMessage>,
): AgentMessage & { role: "assistant" } {
  return {
    ...(existing ?? createAssistantMessage({ content: "" })),
    ...updates,
    role: "assistant",
  };
}

function createToolResultMessage(result: ToolResult): AgentMessage & { role: "toolResult" } {
  return {
    id: createRuntimeId("toolResult"),
    role: "toolResult",
    content: typeof result.output === "string" ? result.output : JSON.stringify(result.output),
    createdAt: new Date().toISOString(),
    toolResult: result,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Agent loop was aborted");
  }
}

function buildAgentState(options: StreamingAgentLoopOptions, messages: AgentMessage[]): AgentState {
  return {
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    model: options.model,
    messages,
    tools: (options.tools ?? []).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
    isStreaming: false,
    pendingToolCalls: [],
  };
}

async function appendToSession(options: StreamingAgentLoopOptions, message: AgentMessage): Promise<void> {
  if (!options.sessionStore || !options.sessionId) return;
  try {
    await options.sessionStore.append({
      id: message.id,
      type: "message",
      sessionId: options.sessionId,
      createdAt: message.createdAt,
      message,
    });
  } catch {
    // session 写入失败不打断 loop
  }
}

async function transformWithCompaction(
  messages: AgentMessage[],
  transformFn: TransformContext,
  transformOpts: { signal?: AbortSignal } | undefined,
  settings: StreamingAgentLoopOptions["compaction"],
): Promise<AgentMessage[]> {
  const base = await transformFn(messages, transformOpts);
  if (!settings?.enabled) {
    return base;
  }

  const result = await compactMessages(base, settings);
  return result.messages;
}

async function retryAfterCompaction(args: {
  messages: AgentMessage[];
  options: StreamingAgentLoopOptions;
}): Promise<boolean> {
  if (!args.options.compaction?.enabled) {
    return false;
  }

  const compacted = await compactMessages(
    args.messages,
    createOverflowRecoverySettings(args.options.compaction),
  );
  args.messages.splice(0, args.messages.length, ...compacted.messages);
  return true;
}
