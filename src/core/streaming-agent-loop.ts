import { DEFAULT_MAX_ITERATIONS } from "./runtime-defaults.js";
import { createRuntimeId } from "./runtime-id.js";
import { defaultTransformContext } from "./context.js";
import type {
  AgentMessage,
  AgentState,
  StreamingAgentLoopOptions,
  Tool,
  ToolCall,
  ToolResult,
} from "./types.js";
import type { AgentContext } from "./context.js";
import type { AgentEventSink } from "./events.js";
import type { StreamFn } from "./stream-types.js";
import type { AgentHooks } from "../hooks/hook-types.js";

/** 空的 emit，避免每次检查 undefined */
const noopEmit: AgentEventSink = () => {};

/**
 * 完整流式 Agent Loop。
 *
 * 这是整个 runtime 最核心的"引擎"——它驱动着下面的循环：
 *
 *   用户说话 → 上下文转换 → 调模型（流式）→ 收集 assistant 消息
 *   → 有工具？执行工具 → 把结果放回消息 → 再调模型
 *   → 没有工具？返回最终回复
 *
 * 相比旧的 runAgentLoop()，这个版本新增了：
 * - 事件发射：外部可以监听每一步发生的事情
 * - abort 支持：调用方可以中途取消
 * - hook 集成：在工具执行前后插入自定义逻辑
 * - 上下文 transform：在发给模型前转换消息（为 compaction 做准备）
 * - session 写入：每轮自动写入 session store
 */
export async function runStreamingAgentLoop(
  input: { userInput?: string; continueOnly?: boolean },
  options: StreamingAgentLoopOptions,
) {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  // 和旧 loop 一样，maxIterations 必须是正整数
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error("maxIterations must be a positive integer");
  }

  const emit = options.emit ?? noopEmit;
  const tools = new Map(
    (options.tools ?? []).map((tool) => [tool.name, tool]),
  );
  // messages 可能有默认空数组，但 streaming-agent-loop 的调用者也可能不传
  const messages: AgentMessage[] = [...(options.messages ?? [])];

  // ---- 处理用户输入 ----
  const userMessage =
    input.userInput && !input.continueOnly
      ? createUserAgentMessage(input.userInput)
      : undefined;

  if (userMessage) {
    // 用户输入 hook：允许修改或增强用户输入
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

  // 发 turn_start 事件
  // exactOptionalPropertyTypes 下 input?: AgentMessage 不接受 undefined，所以只在有值时传
  const turnStartEvent: AgentEventSink = emit;
  if (userMessage) {
    await turnStartEvent({
      type: "turn_start",
      turnId: createRuntimeId("turn"),
      input: userMessage,
    });
  } else {
    await turnStartEvent({
      type: "turn_start",
      turnId: createRuntimeId("turn"),
    });
  }

  // ---- 主循环 ----
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    throwIfAborted(options.signal);

    // 上下文转换：在发给模型前对消息做处理（裁剪、摘要等）
    const transformFn = options.transformContext ?? defaultTransformContext;
    const transformOpts = options.signal
      ? { signal: options.signal }
      : undefined;
    const transformedMessages = await transformFn(messages, transformOpts);

    const context: AgentContext = {
      ...(options.systemPrompt !== undefined
        ? { systemPrompt: options.systemPrompt }
        : {}),
      messages: transformedMessages,
      tools: (options.tools ?? []).map(
        ({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        }),
      ),
    };

    // 调用模型（流式），收集 assistant 消息
    const streamOpts = options.signal ? { signal: options.signal } : undefined;
    const assistant = await streamAssistantMessage({
      context,
      model: options.model,
      streamFn: options.streamFn,
      emit,
      ...(streamOpts ? { signal: streamOpts.signal } : {}),
    });

    messages.push(assistant);

    // 存入 session（如果配置了 session store）
    await appendToSession(options, assistant);

    // 没有工具调用 → 这是最终回复，结束循环
    if (!assistant.toolCalls?.length) {
      await emit({ type: "turn_end", message: assistant, toolResults: [] });
      return { content: assistant.content, messages, iterations: iteration };
    }

    // 执行工具
    const toolResults: ToolResult[] = [];
    const parallelToolCalls: Promise<void>[] = [];

    for (const call of assistant.toolCalls) {
      const tool = tools.get(call.name);
      // 执行单个工具，完成后把 toolResult 消息加入 messages
      const execArgs = {
        call,
        emit,
        hooks: options.hooks,
        state: buildAgentState(options, messages),
      } as Parameters<typeof executeToolCallWithHooks>[0];
      // exactOptionalPropertyTypes 下 signal 和 tool 必须有值才传
      if (options.signal) execArgs.signal = options.signal;
      if (tool) execArgs.tool = tool;
      const executor = executeToolCallWithHooks(execArgs).then((toolResultMessage) => {
        messages.push(toolResultMessage);
        toolResults.push(toolResultMessage.toolResult);
      });

      // 如果工具有 parallel 模式标记，可以和其他工具并发执行
      // 否则串行执行（默认行为，保证执行顺序）
      if (isParallelTool(tool)) {
        parallelToolCalls.push(executor);
      } else {
        await executor;
      }
    }
    // 等待所有并发工具完成
    await Promise.all(parallelToolCalls);
  }

  // 到了这里说明 maxIterations 次循环后还没结束
  throw new Error(
    `Agent loop reached the maximum of ${maxIterations} iterations`,
  );
}

/** 检查工具是否标记为并行执行模式 */
function isParallelTool(tool?: Tool): boolean {
  if (!tool) return false;
  return (
    "executionMode" in tool &&
    (tool as Tool & { executionMode: string }).executionMode === "parallel"
  );
}

// ============================================================
// 内部辅助函数
// ============================================================

/**
 * 以流式方式调模型，收集并组装 assistant 消息。
 */
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

  const streamOpts = args.signal ? { signal: args.signal } : undefined;
  const stream = await args.streamFn(args.model, args.context, streamOpts);

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
        const updated = updateAssistantMessage(message, {
          content,
          toolCalls: [...toolCalls],
        });
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

  // 流结束但没有 done 事件——这是异常情况
  throw new Error("Model stream ended without a done event");
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

/**
 * 执行单个工具调用，包含完整的 hook 流程：
 * 1. beforeToolCall hook → 可能拒绝/修改输入
 * 2. 实际执行工具
 * 3. afterToolCall hook → 可能修改输出/注入附加上下文
 */
async function executeToolCallWithHooks(args: {
  call: ToolCall;
  tool?: Tool;
  emit: AgentEventSink;
  signal?: AbortSignal;
  hooks?: AgentHooks;
  state: AgentState;
}): Promise<AgentMessage & { role: "toolResult" }> {
  // ---- beforeToolCall hook ----
  if (args.hooks?.beforeToolCall) {
    const before = await args.hooks.beforeToolCall(args.call, args.state);
    if (before.behavior === "deny") {
      const deniedResult: ToolResult = {
        toolCallId: args.call.id,
        name: args.call.name,
        output: `Tool execution denied: ${before.reason}`,
        isError: true,
      };
      await args.emit({
        type: "tool_execution_end",
        toolCall: args.call,
        result: deniedResult,
      });
      return createToolResultMessage(deniedResult);
    }
    // allow 时可以修改工具的输入参数
    if (before.behavior === "allow" && before.input !== undefined) {
      args = { ...args, call: { ...args.call, input: before.input } };
    }
  }

  // ---- 执行工具 ----
  await args.emit({ type: "tool_execution_start", toolCall: args.call });

  const rawResult = await executeToolCall(args.call, args.tool, args.signal);
  let result = rawResult;

  // ---- afterToolCall hook ----
  if (args.hooks?.afterToolCall) {
    const after = await args.hooks.afterToolCall(
      args.call,
      result,
      args.state,
    );
    if (after?.output !== undefined) {
      result = { ...result, output: after.output };
    }
  }

  await args.emit({
    type: "tool_execution_end",
    toolCall: args.call,
    result,
  });

  const toolResultMessage = createToolResultMessage(result);

  // 如果 after hook 有附加上下文，存进 metadata
  if (args.hooks?.afterToolCall) {
    const after = await args.hooks.afterToolCall(
      args.call,
      result,
      args.state,
    );
    if (after?.additionalContext) {
      toolResultMessage.metadata = {
        ...toolResultMessage.metadata,
        additionalContext: after.additionalContext,
      };
    }
  }

  return toolResultMessage;
}

/**
 * 实际执行工具：查找工具 → 调用 → 错误处理。
 * 未知工具和工具执行异常都会变成 error toolResult，不会让整个 loop 崩掉。
 */
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
    // 旧工具接口期望 RunContext，新工具接口期望 ToolExecutionContext
    // 这里传 undefined 保持向后兼容——新工具的 signal 支持会在 Stage F 中完善
    const output = await tool.execute(call.input);
    return {
      toolCallId: call.id,
      name: call.name,
      output,
    };
  } catch (error) {
    return {
      toolCallId: call.id,
      name: call.name,
      output: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

// ============================================================
// 消息工厂函数
// ============================================================

function createUserAgentMessage(
  content: string,
): AgentMessage & { role: "user" } {
  return {
    id: createRuntimeId("user"),
    role: "user",
    content,
    createdAt: new Date().toISOString(),
  };
}

function createAssistantMessage(
  partial: { id?: string; content: string; createdAt?: string },
): AgentMessage & { role: "assistant" } {
  return {
    id: partial.id ?? createRuntimeId("assistant"),
    role: "assistant",
    content: partial.content,
    createdAt: partial.createdAt ?? new Date().toISOString(),
  };
}

function createToolResultMessage(
  result: ToolResult,
): AgentMessage & { role: "toolResult" } {
  return {
    id: createRuntimeId("toolResult"),
    role: "toolResult",
    content:
      typeof result.output === "string"
        ? result.output
        : JSON.stringify(result.output),
    createdAt: new Date().toISOString(),
    toolResult: result,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Agent loop was aborted");
  }
}

function buildAgentState(
  options: StreamingAgentLoopOptions,
  messages: AgentMessage[],
): AgentState {
  return {
    ...(options.systemPrompt !== undefined
      ? { systemPrompt: options.systemPrompt }
      : {}),
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

/**
 * 把 assistant 消息写入 session store。
 * session 写入失败不应该打断 agent loop——这是"尽力写入"。
 */
async function appendToSession(
  options: StreamingAgentLoopOptions,
  message: AgentMessage,
): Promise<void> {
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
