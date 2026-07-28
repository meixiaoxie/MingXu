import type { ModelConfig } from "../config/config-schema.js";
import type { Message, ModelInput, ModelOutput, ModelProvider, ToolCall } from "../core/types.js";
import type { ProviderDebugLogger } from "../cli/provider-debug.js";
import type { RuntimeTool } from "../tools/index.js";
import { zodToJsonSchema } from "../tools/zod-json-schema.js";
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
