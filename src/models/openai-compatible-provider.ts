import { z } from "zod";

import { normalizeModelError } from "./execution-errors.js";
import { defaultModelCapabilities } from "./model-capabilities.js";
import {
  parseOpenAICompatibleResponse,
  toOpenAICompatibleRequest,
} from "./openai-compatible-format.js";
import { parseSseStream } from "./sse.js";
import { resolveProviderSecret } from "./provider-env.js";
import type { ModelEvent, ModelRequest, ModelResponse, ModelToolCall } from "./model-protocol.js";
import type { ModelExecutionOptions, ModelAdapter } from "./provider-registry.js";
import type { ProviderDebugLogger } from "../cli/provider-debug.js";

const DEFAULT_OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

const optionsSchema = z.object({
  provider: z.string().trim().min(1).default("openai"),
  apiKey: z.string().trim().min(1).optional(),
  apiKeyEnv: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().url().optional(),
  debug: z.unknown().optional(),
}).strict();

export interface OpenAICompatibleProviderOptions {
  /** Stable runtime name, for example openai, deepseek, kimi, zhipu, or glm. */
  provider?: string | undefined;
  apiKey?: string | undefined;
  /** Environment variable used when apiKey is omitted. Defaults from provider name. */
  apiKeyEnv?: string | undefined;
  /** Either an API root ending in /v1 or the complete /chat/completions URL. */
  baseUrl?: string | undefined;
  debug?: ProviderDebugLogger | undefined;
}

/**
 * Shared Chat Completions adapter for OpenAI and vendors exposing the same API.
 * The catalog only needs to supply a provider name, endpoint, and credential name.
 */
export class OpenAICompatibleProvider implements ModelAdapter {
  readonly provider: string;
  readonly capabilities = defaultModelCapabilities;
  readonly #apiKey: string | undefined;
  readonly #apiKeyEnv: string;
  readonly #endpoint: string;
  readonly #debug: ProviderDebugLogger | undefined;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    const parsed = optionsSchema.parse(options);
    this.provider = parsed.provider;
    this.#apiKeyEnv = parsed.apiKeyEnv ?? defaultApiKeyEnvironment(parsed.provider);
    this.#apiKey = resolveProviderSecret(parsed.apiKey, this.#apiKeyEnv);
    this.#endpoint = resolveChatCompletionsEndpoint(
      parsed.baseUrl ?? DEFAULT_OPENAI_CHAT_COMPLETIONS_URL,
    );
    this.#debug = parsed.debug as ProviderDebugLogger | undefined;
  }

  async generate(request: ModelRequest, options: ModelExecutionOptions = {}): Promise<ModelResponse> {
    if (!this.#apiKey) {
      throw new Error(
        `${this.provider} apiKey is required in config or ${this.#apiKeyEnv}`,
      );
    }

    let response: Response;
    const requestBody = toOpenAICompatibleRequest(request);
    this.#debug?.log("openai-compatible.generate", {
      provider: this.provider,
      endpoint: this.#endpoint,
      apiKeyEnv: this.#apiKeyEnv,
      apiKeyPresent: this.#apiKey !== undefined,
      authorizationPresent: this.#apiKey !== undefined,
      authorizationScheme: this.#apiKey !== undefined ? "Bearer" : undefined,
      requestBody,
    });
    try {
      response = await fetch(this.#endpoint, {
        method: "POST",
        // API keys must not be forwarded if a compatible endpoint redirects elsewhere.
        redirect: "error",
        ...(options.signal ? { signal: options.signal } : {}),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      throw normalizeModelError({ provider: this.provider, error });
    }

    if (!response.ok) {
      throw normalizeModelError({
        provider: this.provider,
        error: new Error(`${this.provider} OpenAI-compatible request failed with status ${response.status}`),
        status: response.status,
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw normalizeModelError({
        provider: this.provider,
        error: new Error(`${this.provider} returned an invalid OpenAI-compatible JSON response`),
      });
    }
    return parseOpenAICompatibleResponse(body, this.provider);
  }

  async *stream(request: ModelRequest, options: ModelExecutionOptions = {}): AsyncIterable<ModelEvent> {
    if (!this.#apiKey) {
      throw new Error(
        `${this.provider} apiKey is required in config or ${this.#apiKeyEnv}`,
      );
    }

    const requestBody = {
      ...toOpenAICompatibleRequest(request),
      stream: true,
      stream_options: { include_usage: true },
    };

    let response: Response;
    this.#debug?.log("openai-compatible.stream", {
      provider: this.provider,
      endpoint: this.#endpoint,
      apiKeyEnv: this.#apiKeyEnv,
      apiKeyPresent: this.#apiKey !== undefined,
      authorizationPresent: this.#apiKey !== undefined,
      authorizationScheme: this.#apiKey !== undefined ? "Bearer" : undefined,
      requestBody,
    });

    try {
      response = await fetch(this.#endpoint, {
        method: "POST",
        redirect: "error",
        ...(options.signal ? { signal: options.signal } : {}),
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      yield createStreamErrorEvent(this.provider, error);
      throw normalizeModelError({ provider: this.provider, error });
    }

    if (!response.ok) {
      const error = new Error(`${this.provider} OpenAI-compatible request failed with status ${response.status}`);
      yield createStreamErrorEvent(this.provider, error, { status: response.status });
      throw normalizeModelError({
        provider: this.provider,
        error,
        status: response.status,
      });
    }

    yield { type: "start", request };

    try {
      const streamState = createOpenAIStreamState();
      for await (const event of parseSseStream(response.body, options.signal)) {
        if (!event.data || event.data === "[DONE]") {
          if (event.data === "[DONE]") break;
          continue;
        }

        const payload = JSON.parse(event.data) as OpenAIStreamChunk;
        for (const delta of consumeOpenAIStreamChunk(payload, streamState)) {
          yield { type: "delta", text: delta };
        }
      }

      const responseData = finalizeOpenAIStream(streamState);
      yield { type: "end", response: responseData };
    } catch (error) {
      yield createStreamErrorEvent(this.provider, error);
      throw normalizeModelError({ provider: this.provider, error });
    }
  }
}

function defaultApiKeyEnvironment(provider: string): string {
  return `${provider.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`;
}

function resolveChatCompletionsEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("OpenAI-compatible baseUrl must be an HTTPS URL without credentials or a hash");
  }

  // Accepting both forms makes catalog definitions natural: vendors usually publish
  // an API root, while self-hosted gateways often document the complete endpoint.
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/chat/completions")) {
    url.pathname = `${path}/chat/completions`.replace(/^\/?/, "/");
  } else {
    url.pathname = path;
  }
  return url.toString();
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      refusal?: unknown;
      tool_calls?: unknown;
    };
    finish_reason?: unknown;
  }>;
  usage?: unknown;
}

interface OpenAIStreamToolCallState {
  id?: string;
  name?: string;
  arguments: string;
}

interface OpenAIStreamState {
  text: string;
  refusal?: string;
  stopReason?: string;
  usage?: ModelResponse["usage"];
  toolCalls: Map<number, OpenAIStreamToolCallState>;
}

function createOpenAIStreamState(): OpenAIStreamState {
  return {
    text: "",
    toolCalls: new Map<number, OpenAIStreamToolCallState>(),
  };
}

function consumeOpenAIStreamChunk(chunk: OpenAIStreamChunk, state: OpenAIStreamState): string[] {
  const deltas: string[] = [];
  const choice = chunk.choices?.[0];
  if (!choice) {
    state.usage = state.usage ?? parseOpenAIUsage(chunk.usage);
    return deltas;
  }

  const delta = choice.delta;
  if (typeof delta?.content === "string") {
    state.text += delta.content;
    deltas.push(delta.content);
  }
  if (typeof delta?.refusal === "string") {
    state.refusal = (state.refusal ?? "") + delta.refusal;
  }
  if (Array.isArray(delta?.tool_calls)) {
    for (const rawToolCall of delta.tool_calls) {
      consumeOpenAIToolCallDelta(rawToolCall, state.toolCalls);
    }
  }
  if (typeof choice.finish_reason === "string") {
    state.stopReason = choice.finish_reason;
  }
  state.usage = parseOpenAIUsage(chunk.usage) ?? state.usage;
  return deltas;
}

function consumeOpenAIToolCallDelta(
  value: unknown,
  toolCalls: Map<number, OpenAIStreamToolCallState>,
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  const call = value as {
    index?: unknown;
    id?: unknown;
    function?: {
      name?: unknown;
      arguments?: unknown;
    };
  };
  const index = typeof call.index === "number" ? call.index : 0;
  const state = toolCalls.get(index) ?? { arguments: "" };
  if (typeof call.id === "string") {
    state.id = call.id;
  }
  if (typeof call.function?.name === "string") {
    state.name = call.function.name;
  }
  if (typeof call.function?.arguments === "string") {
    state.arguments += call.function.arguments;
  } else if (call.function?.arguments && typeof call.function.arguments === "object") {
    state.arguments = JSON.stringify(call.function.arguments);
  }
  toolCalls.set(index, state);
}

function finalizeOpenAIStream(state: OpenAIStreamState): ModelResponse {
  const toolCalls = [...state.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => {
      if (!toolCall.name) {
        throw new Error("OpenAI-compatible stream returned a tool call without a name");
      }
      return {
        id: toolCall.id ?? `openai-tool-call-${toolCall.name}`,
        name: toolCall.name,
        input: parseOpenAIArguments(toolCall.arguments),
      } satisfies ModelToolCall;
    });

  return {
    text: state.text,
    toolCalls,
    ...(state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
    ...(state.usage !== undefined ? { usage: state.usage } : {}),
    ...(state.refusal !== undefined ? { refusal: state.refusal } : {}),
  };
}

function parseOpenAIArguments(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function parseOpenAIUsage(value: unknown): ModelResponse["usage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  const result = {
    ...(typeof usage.prompt_tokens === "number" ? { inputTokens: usage.prompt_tokens } : {}),
    ...(typeof usage.completion_tokens === "number" ? { outputTokens: usage.completion_tokens } : {}),
    ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function createStreamErrorEvent(provider: string, error: unknown, extra?: Record<string, unknown>): ModelEvent {
  return {
    type: "error",
    error: error instanceof Error ? error.message : String(error),
    ...(extra !== undefined ? { rawProviderData: { provider, ...extra } } : { rawProviderData: { provider } }),
  };
}
