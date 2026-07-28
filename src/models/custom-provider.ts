import { z } from "zod";

import { normalizeModelError } from "./execution-errors.js";
import { defaultModelCapabilities } from "./model-capabilities.js";
import type { ModelRequest, ModelResponse, ModelToolCall } from "./model-protocol.js";
import type { ModelExecutionOptions, ModelAdapter } from "./provider-registry.js";

const customProviderOptionsSchema = z.object({
  protocol: z.literal("openai-compatible").default("openai-compatible"),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().trim().min(1).optional(),
});

/**
 * Custom providers deliberately implement one documented wire contract rather
 * than forwarding arbitrary JSON. New protocols should get their own adapter.
 */
export interface CustomProviderOptions {
  protocol?: "openai-compatible" | undefined;
  /** Full OpenAI-compatible chat completions endpoint. */
  baseUrl: string;
  apiKey?: string | undefined;
}

interface OpenAIChoice {
  message?: unknown;
  finish_reason?: unknown;
}

interface OpenAIUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  prompt_tokens_details?: unknown;
}

interface OpenAIResponse {
  choices?: unknown;
  usage?: unknown;
}

export class CustomProvider implements ModelAdapter {
  readonly provider = "custom";
  readonly capabilities = {
    ...defaultModelCapabilities,
    supportsStructuredOutput: true,
  };
  readonly protocol = "openai-compatible";
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;

  constructor(options: CustomProviderOptions) {
    const parsed = customProviderOptionsSchema.parse(options);
    this.#baseUrl = validateCustomEndpoint(parsed.baseUrl);
    this.#apiKey = parsed.apiKey;
  }

  async generate(request: ModelRequest, options: ModelExecutionOptions = {}): Promise<ModelResponse> {
    let response: Response;
    try {
      response = await fetch(this.#baseUrl, {
        method: "POST",
        // The configured endpoint is the credential boundary. Refusing redirects
        // prevents an upstream from silently forwarding the optional API key.
        redirect: "error",
        ...(options.signal ? { signal: options.signal } : {}),
        headers: {
          "content-type": "application/json",
          ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify(buildOpenAICompatibleRequest(request)),
      });
    } catch (error) {
      throw normalizeModelError({ provider: this.provider, error });
    }

    if (!response.ok) {
      throw normalizeModelError({
        provider: this.provider,
        error: new Error(`Custom provider request failed with status ${response.status}`),
        status: response.status,
      });
    }

    try {
      return parseOpenAICompatibleResponse(await response.json());
    } catch (error) {
      throw normalizeModelError({ provider: this.provider, error });
    }
  }
}

function validateCustomEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Custom provider baseUrl must be an HTTPS endpoint without credentials or fragments");
  }
  return url.toString();
}

function buildOpenAICompatibleRequest(request: ModelRequest): Record<string, unknown> {
  return {
    model: request.modelId,
    messages: [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      ...request.messages.map((message) => {
        if (message.role === "tool") {
          if (!message.toolCallId) {
            throw new Error("Custom provider tool result messages require a toolCallId");
          }
          return {
            role: "tool",
            content: message.content,
            tool_call_id: message.toolCallId,
          };
        }
        if (message.role === "assistant" && message.toolCalls?.length) {
          return {
            role: "assistant",
            content: message.content || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.input),
              },
            })),
          };
        }
        return { role: message.role, content: message.content };
      }),
    ],
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
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.responseFormat === "json"
      ? { response_format: { type: "json_object" } }
      : {}),
  };
}

function parseOpenAICompatibleResponse(value: unknown): ModelResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Custom provider returned an invalid response: expected an object");
  }
  const response = value as OpenAIResponse;
  if (!Array.isArray(response.choices) || response.choices.length === 0) {
    throw new Error("Custom provider returned an invalid response: choices must be a non-empty array");
  }

  const choice = response.choices[0] as OpenAIChoice | undefined;
  if (!choice?.message || typeof choice.message !== "object") {
    throw new Error("Custom provider returned an invalid response: choice message is missing");
  }
  const message = choice.message as { content?: unknown; tool_calls?: unknown };
  if (message.content !== null && message.content !== undefined && typeof message.content !== "string") {
    throw new Error("Custom provider returned an invalid response: message content must be a string or null");
  }

  const toolCalls = parseOpenAIToolCalls(message.tool_calls);
  const usage = parseOpenAIUsage(response.usage);
  return {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    ...(typeof choice.finish_reason === "string" ? { stopReason: choice.finish_reason } : {}),
    ...(usage ? { usage } : {}),
  };
}

function parseOpenAIToolCalls(value: unknown): ModelToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Custom provider returned an invalid response: tool_calls must be an array");
  }

  return value.map((rawCall) => {
    if (!rawCall || typeof rawCall !== "object") {
      throw new Error("Custom provider returned an invalid response: malformed tool call");
    }
    const call = rawCall as { id?: unknown; function?: unknown };
    const fn = call.function as { name?: unknown; arguments?: unknown } | null;
    if (typeof call.id !== "string" || !fn || typeof fn !== "object"
      || typeof fn.name !== "string" || typeof fn.arguments !== "string") {
      throw new Error("Custom provider returned an invalid response: malformed function tool call");
    }

    let input: unknown;
    try {
      input = JSON.parse(fn.arguments);
    } catch {
      throw new Error(`Custom provider returned invalid JSON arguments for tool ${fn.name}`);
    }
    return { id: call.id, name: fn.name, input };
  });
}

function parseOpenAIUsage(value: unknown): ModelResponse["usage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as OpenAIUsage;
  const details = usage.prompt_tokens_details;
  const cachedTokens = details && typeof details === "object"
    ? (details as { cached_tokens?: unknown }).cached_tokens
    : undefined;
  const result = {
    ...(typeof usage.prompt_tokens === "number" ? { inputTokens: usage.prompt_tokens } : {}),
    ...(typeof usage.completion_tokens === "number" ? { outputTokens: usage.completion_tokens } : {}),
    ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
    ...(typeof cachedTokens === "number" ? { cacheReadTokens: cachedTokens } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}
