import type {
  ModelRequest,
  ModelRequestMessage,
  ModelResponse,
  ModelToolCall,
} from "./model-protocol.js";

interface OpenAICompatibleChoice {
  finish_reason?: unknown;
  message?: unknown;
}

interface OpenAICompatibleMessage {
  content?: unknown;
  refusal?: unknown;
  tool_calls?: unknown;
}

interface OpenAICompatibleToolCall {
  id?: unknown;
  type?: unknown;
  function?: unknown;
}

interface OpenAICompatibleFunctionCall {
  name?: unknown;
  arguments?: unknown;
}

/**
 * Converts the runtime's neutral request into the common Chat Completions shape.
 * Provider-specific authentication and endpoint selection stay in the provider class.
 */
export function toOpenAICompatibleRequest(request: ModelRequest): Record<string, unknown> {
  const messages = request.messages.map(toOpenAICompatibleMessage);
  if (request.system !== undefined) {
    messages.unshift({ role: "system", content: request.system });
  }

  return {
    model: request.modelId,
    messages,
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.responseFormat === "json"
      ? { response_format: { type: "json_object" } }
      : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }
      : {}),
  };
}

/** Parses a Chat Completions response and rejects incomplete success payloads early. */
export function parseOpenAICompatibleResponse(
  value: unknown,
  provider: string,
): ModelResponse {
  const prefix = `${provider} returned an invalid OpenAI-compatible response`;
  if (!isRecord(value)) {
    throw new Error(`${prefix}: expected an object`);
  }
  if (!Array.isArray(value.choices) || value.choices.length === 0) {
    throw new Error(`${prefix}: choices must be a non-empty array`);
  }

  const choice = value.choices[0] as OpenAICompatibleChoice | undefined;
  if (!isRecord(choice?.message)) {
    throw new Error(`${prefix}: choices[0].message must be an object`);
  }

  const message = choice.message as OpenAICompatibleMessage;
  if (message.content !== null && message.content !== undefined && typeof message.content !== "string") {
    throw new Error(`${prefix}: message.content must be a string or null`);
  }

  const response: ModelResponse = {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls: parseToolCalls(message.tool_calls, prefix),
  };
  if (typeof choice.finish_reason === "string") response.stopReason = choice.finish_reason;
  if (typeof message.refusal === "string") response.refusal = message.refusal;

  const usage = parseUsage(value.usage);
  if (usage) response.usage = usage;
  return response;
}

function toOpenAICompatibleMessage(message: ModelRequestMessage): Record<string, unknown> {
  if (message.role === "tool") {
    if (!message.toolCallId) {
      throw new Error("OpenAI-compatible tool messages require toolCallId");
    }
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
      ...(message.name ? { name: message.name } : {}),
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      // OpenAI accepts null when an assistant delegates all work to tools.
      content: message.content || null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.input ?? null),
        },
      })),
    };
  }

  return { role: message.role, content: message.content };
}

function parseToolCalls(value: unknown, prefix: string): ModelToolCall[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${prefix}: message.tool_calls must be an array`);
  }

  return value.map((rawCall, index) => {
    const call = rawCall as OpenAICompatibleToolCall;
    if (!isRecord(call) || typeof call.id !== "string" || !isRecord(call.function)) {
      throw new Error(`${prefix}: tool_calls[${index}] is malformed`);
    }

    const functionCall = call.function as OpenAICompatibleFunctionCall;
    if (typeof functionCall.name !== "string") {
      throw new Error(`${prefix}: tool_calls[${index}].function.name must be a string`);
    }

    return {
      id: call.id,
      name: functionCall.name,
      input: parseFunctionArguments(functionCall.arguments, prefix, index),
    };
  });
}

function parseFunctionArguments(
  value: unknown,
  prefix: string,
  index: number,
): unknown {
  // A few compatible vendors return an already-decoded object, while OpenAI
  // returns a JSON string. Supporting both keeps the shared adapter portable.
  if (isRecord(value) || Array.isArray(value)) return value;
  if (typeof value !== "string") {
    throw new Error(`${prefix}: tool_calls[${index}].function.arguments must be JSON`);
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${prefix}: tool_calls[${index}].function.arguments contains invalid JSON`);
  }
}

function parseUsage(value: unknown): ModelResponse["usage"] | undefined {
  if (!isRecord(value)) return undefined;

  const usage = {
    ...(typeof value.prompt_tokens === "number" ? { inputTokens: value.prompt_tokens } : {}),
    ...(typeof value.completion_tokens === "number" ? { outputTokens: value.completion_tokens } : {}),
    ...(typeof value.total_tokens === "number" ? { totalTokens: value.total_tokens } : {}),
  };
  return Object.keys(usage).length ? usage : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
