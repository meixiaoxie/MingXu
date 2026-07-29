import type { ModelConfig } from "../config/config-schema.js";
import type { Message, ModelInput, ModelOutput, ModelProvider, ToolCall } from "../core/types.js";
import type { ProviderDebugLogger } from "../cli/provider-debug.js";
import type { RuntimeTool } from "../tools/index.js";
import { zodToJsonSchema } from "../tools/zod-json-schema.js";
import type { ModelAdapter } from "./provider-registry.js";
import { ModelExecutor } from "./model-executor.js";
import type {
  ModelRequest,
  ModelRequestMessage,
  ModelResponse,
  ModelToolCall,
  ModelEvent,
} from "./model-protocol.js";
import { createRuntimeId } from "../core/runtime-id.js";
import { defaultConvertToLlm } from "../core/context.js";
import type {
  AssistantStreamEvent,
  StreamFn,
} from "../core/stream-types.js";
import type { AgentMessage } from "../core/types.js";

export function toModelRequest(input: ModelInput, config: ModelConfig): ModelRequest {
  return {
    modelId: config.model,
    messages: input.messages.map(toModelRequestMessage),
    ...(input.tools
      ? {
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: zodToJsonSchema((tool as RuntimeTool).inputSchema),
          })),
        }
      : {}),
    ...(input.systemPrompt !== undefined ? { system: input.systemPrompt } : {}),
  };
}

export function toModelOutput(response: ModelResponse, providerName?: string): ModelOutput {
  return {
    content: response.text,
    toolCalls: response.toolCalls.map(toToolCall),
    ...(response.stopReason !== undefined ? { stopReason: response.stopReason } : {}),
    ...(response.usage !== undefined ? { usage: response.usage } : {}),
    ...(response.refusal !== undefined ? { refusal: response.refusal } : {}),
    ...(response.errors !== undefined ? { errors: response.errors } : {}),
    ...(response.rawProviderData !== undefined ? { rawProviderData: response.rawProviderData } : {}),
    ...(providerName !== undefined ? { providerRequestId: `${providerName}:request` } : {}),
  };
}

export function createRuntimeModelProvider(
  adapter: ModelAdapter,
  config: ModelConfig,
  debug?: ProviderDebugLogger,
): ModelProvider {
  return {
    async generate(input: ModelInput): Promise<ModelOutput> {
      const request = toModelRequest(input, config);
      debug?.log("request-builder.model-request", {
        adapterProvider: adapter.provider,
        modelConfig: config,
        request,
      });
      const response = await adapter.generate(request);
      return toModelOutput(response, adapter.provider);
    },
  };
}

function toModelRequestMessage(message: Message): ModelRequestMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      toolCallId: message.toolResult.toolCallId,
      name: message.toolResult.name,
      ...(message.toolResult.isError !== undefined ? { isError: message.toolResult.isError } : {}),
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content,
      toolCalls: message.toolCalls.map(toModelToolCall),
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function toModelToolCall(toolCall: ToolCall): ModelToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
  };
}

function toToolCall(toolCall: ModelToolCall): ToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
  };
}

// ============================================================
// Stream bridge：把 model adapter 的 stream/generate 转成 core 的 StreamFn
// ============================================================

/**
 * 把 model adapter 的 stream（或 generate）转成 core 层的 StreamFn。
 *
 * 这是两层协议之间的"翻译官"：
 * - 输入：ModelAdapter（provider 层） + ModelConfig
 * - 输出：StreamFn（core 层）
 *
 * 流程：
 * 1. 如果 adapter 有 stream 方法 → 走真正流式，把 ModelEvent 转成 AssistantStreamEvent
 * 2. 如果没有 → 走 generate，把结果包装成流式事件
 */
export function createRuntimeStreamFn(
  adapter: ModelAdapter,
  config: ModelConfig,
  debug?: ProviderDebugLogger,
): StreamFn {
  return async function* runtimeStreamFn(_model, context, options) {
    const input = await defaultConvertToLlm(context);
    const executor = new ModelExecutor(adapter, config);
    const assistantMessageId = createRuntimeId("assistant");
    debug?.log("request-builder.model-request", {
      adapterProvider: adapter.provider,
      modelConfig: config,
      request: toModelRequest(input, config),
    });

    for await (const event of executor.stream({
      input,
      context: options?.signal ? { signal: options.signal } : {},
    })) {
      const converted = modelEventToAssistantEvent(event, assistantMessageId);
      if (converted === null) continue;
      yield converted;
    }
  };
}

/** 把单个 ModelEvent 转成 AssistantStreamEvent，不相关的返回 null */
function modelEventToAssistantEvent(
  event: ModelEvent,
  messageId: string,
): AssistantStreamEvent | null {
  switch (event.type) {
    case "start":
      return { type: "start", messageId };

    case "delta":
      return { type: "text_delta", text: event.text };

    case "tool_call":
      return {
        type: "tool_call",
        toolCall: event.toolCall as ToolCall,
      };

    case "end":
      return {
        type: "done",
        message: modelResponseToAgentMessage(event.response),
      };

    case "error":
      return { type: "error", error: event.error };

    // provider 层的 tool_result 事件不转成 assistant 输出，跳过
    case "tool_result":
      return null;

    default:
      return null;
  }
}

/** 把 ModelResponse 转成 AgentMessage */
function modelResponseToAgentMessage(response: ModelResponse): AgentMessage {
  return {
    id: createRuntimeId("assistant"),
    role: "assistant",
    content: response.text,
    createdAt: new Date().toISOString(),
    ...(response.toolCalls.length > 0
      ? { toolCalls: response.toolCalls as ToolCall[] }
      : {}),
    ...(response.stopReason !== undefined
      ? { stopReason: response.stopReason }
      : {}),
    ...(response.usage !== undefined ? { usage: response.usage } : {}),
  };
}

/** 把 ModelResponse 包装成流式事件（generate fallback 用） */
async function* modelResponseToAssistantEvents(
  response: ModelResponse,
): AsyncGenerator<AssistantStreamEvent> {
  const messageId = createRuntimeId("assistant");
  yield { type: "start", messageId };

  if (response.text) {
    yield { type: "text_delta", text: response.text };
  }

  for (const toolCall of response.toolCalls) {
    yield { type: "tool_call", toolCall: toolCall as ToolCall };
  }

  yield {
    type: "done",
    message: modelResponseToAgentMessage(response),
  };
}
