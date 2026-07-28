import { z } from "zod";

import { normalizeModelError } from "./execution-errors.js";
import { defaultModelCapabilities } from "./model-capabilities.js";
import { readProviderEnv } from "./provider-env.js";
import type { ModelExecutionOptions, ModelAdapter } from "./provider-registry.js";
import type { ModelRequest, ModelResponse, ModelToolCall } from "./model-protocol.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const anthropicInputSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().trim().url().optional(),
});

interface AnthropicProviderOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

interface AnthropicBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  stop_reason?: unknown;
  content?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
}

export class AnthropicProvider implements ModelAdapter {
  readonly provider = "anthropic";
  readonly capabilities = defaultModelCapabilities;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;

  constructor(options: AnthropicProviderOptions = {}) {
    const parsed = anthropicInputSchema.parse(options);
    this.#apiKey = parsed.apiKey?.trim() || readProviderEnv("ANTHROPIC_API_KEY");
    this.#baseUrl = validateAnthropicBaseUrl(parsed.baseUrl ?? ANTHROPIC_MESSAGES_URL);
  }

  async generate(request: ModelRequest, options: ModelExecutionOptions = {}): Promise<ModelResponse> {
    if (!this.#apiKey) {
      throw new Error("Anthropic apiKey is required in config or ANTHROPIC_API_KEY");
    }

    let response: Response;
    try {
      response = await fetch(this.#baseUrl, {
        method: "POST",
        // Do not follow redirects: a redirected request could forward the API key
        // outside the trusted Anthropic endpoint validated in the constructor.
        redirect: "error",
        ...(options.signal ? { signal: options.signal } : {}),
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: request.modelId,
          max_tokens: request.maxTokens ?? 1024,
          ...(request.system !== undefined ? { system: request.system } : {}),
          messages: request.messages.map(toAnthropicMessage),
          ...(request.tools?.length
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.inputSchema,
                })),
              }
            : {}),
        }),
      });
    } catch (error) {
      throw normalizeModelError({ provider: this.provider, error });
    }

    if (!response.ok) {
      throw normalizeModelError({
        provider: this.provider,
        error: new Error(`Anthropic request failed with status ${response.status}`),
        status: response.status,
      });
    }

    try {
      return parseAnthropicResponse(await response.json());
    } catch (error) {
      throw normalizeModelError({ provider: this.provider, error });
    }
  }
}

/** Ensures the API key can only be sent to Anthropic's official Messages endpoint. */
function validateAnthropicBaseUrl(value: string): string {
  const url = new URL(value);
  const isOfficialEndpoint = url.protocol === "https:"
    && url.hostname === "api.anthropic.com"
    && (url.port === "" || url.port === "443")
    && url.username === ""
    && url.password === ""
    && url.pathname === "/v1/messages"
    && url.search === ""
    && url.hash === "";

  if (!isOfficialEndpoint) {
    throw new Error(
      "Anthropic baseUrl must be the official HTTPS Messages endpoint: "
      + ANTHROPIC_MESSAGES_URL,
    );
  }

  return ANTHROPIC_MESSAGES_URL;
}

function toAnthropicMessage(message: ModelRequest["messages"][number]): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
          is_error: message.isError ?? false,
        },
      ],
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...message.toolCalls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        })),
      ],
    };
  }

  return { role: message.role, content: message.content };
}

function parseAnthropicResponse(value: unknown): ModelResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Anthropic returned an invalid response: expected an object");
  }

  const response = value as AnthropicBlock;
  if (!Array.isArray(response.content)) {
    throw new Error("Anthropic returned an invalid response: content must be an array");
  }

  const text: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  for (const rawBlock of response.content) {
    if (!rawBlock || typeof rawBlock !== "object") continue;
    const block = rawBlock as AnthropicBlock;
    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  return {
    text: text.join("\n"),
    toolCalls,
    ...(typeof response.stop_reason === "string" ? { stopReason: response.stop_reason } : {}),
    ...(response.usage ? {
      usage: {
        ...(typeof response.usage.input_tokens === "number" ? { inputTokens: response.usage.input_tokens } : {}),
        ...(typeof response.usage.output_tokens === "number" ? { outputTokens: response.usage.output_tokens } : {}),
        ...(
          typeof response.usage.input_tokens === "number" && typeof response.usage.output_tokens === "number"
            ? { totalTokens: response.usage.input_tokens + response.usage.output_tokens }
            : {}
        ),
        ...(typeof response.usage.cache_read_input_tokens === "number"
          ? { cacheReadTokens: response.usage.cache_read_input_tokens }
          : {}),
        ...(typeof response.usage.cache_creation_input_tokens === "number"
          ? { cacheWriteTokens: response.usage.cache_creation_input_tokens }
          : {}),
      },
    } : {}),
  };
}
