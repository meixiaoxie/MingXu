import type { ModelConfig } from "../config/config-schema.js";
import type { AgentLoopOptions, Message, ModelInput, ModelOutput, ModelProvider, ToolCall } from "../core/types.js";
import type { ModelAdapter } from "./provider-registry.js";
import type { ModelRequest, ModelRequestMessage, ModelResponse, ModelToolCall } from "./model-protocol.js";

export function toModelRequest(input: ModelInput, config: ModelConfig): ModelRequest {
  return {
    modelId: config.model,
    messages: input.messages.map(toModelRequestMessage),
    ...(input.tools
      ? {
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }
      : {}),
    ...(input.systemPrompt !== undefined ? { system: input.systemPrompt } : {}),
  };
}

export function toModelOutput(response: ModelResponse): ModelOutput {
  return {
    content: response.text,
    toolCalls: response.toolCalls.map(toToolCall),
    ...(response.stopReason !== undefined ? { stopReason: response.stopReason } : {}),
  };
}

export function createRuntimeModelProvider(
  adapter: ModelAdapter,
  config: ModelConfig,
): ModelProvider {
  return {
    async generate(input: ModelInput): Promise<ModelOutput> {
      const response = await adapter.generate(toModelRequest(input, config));
      return toModelOutput(response);
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
