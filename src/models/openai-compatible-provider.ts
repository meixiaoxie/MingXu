import { z } from "zod";

import { normalizeModelError } from "./execution-errors.js";
import { defaultModelCapabilities } from "./model-capabilities.js";
import {
  parseOpenAICompatibleResponse,
  toOpenAICompatibleRequest,
} from "./openai-compatible-format.js";
import { readProviderEnv } from "./provider-env.js";
import type { ModelRequest, ModelResponse } from "./model-protocol.js";
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
    this.#apiKey = parsed.apiKey ?? readProviderEnv(this.#apiKeyEnv);
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
