import { z } from "zod";

import { withExecutionSignal } from "../core/execution-signal.js";
import { normalizeModelError } from "./execution-errors.js";
import { defaultModelCapabilities } from "./model-capabilities.js";
import { buildGeminiRequest, parseGeminiResponse } from "./gemini-format.js";
import { readProviderEnv } from "./provider-env.js";
import type { ModelExecutionOptions, ModelAdapter } from "./provider-registry.js";
import type { ModelRequest, ModelResponse } from "./model-protocol.js";

const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const geminiInputSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().trim().url().optional(),
});

export interface GeminiProviderOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

export class GeminiProvider implements ModelAdapter {
  readonly provider = "gemini";
  readonly capabilities = {
    ...defaultModelCapabilities,
    supportsStructuredOutput: true,
  };
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;

  constructor(options: GeminiProviderOptions = {}) {
    const parsed = geminiInputSchema.parse(options);
    this.#apiKey = parsed.apiKey?.trim() || readProviderEnv("GEMINI_API_KEY");
    this.#baseUrl = validateGeminiBaseUrl(parsed.baseUrl ?? GEMINI_API_ROOT);
  }

  async generate(request: ModelRequest, options: ModelExecutionOptions = {}): Promise<ModelResponse> {
    if (!this.#apiKey) {
      throw new Error("Gemini apiKey is required in config or GEMINI_API_KEY");
    }
    if (!request.modelId.trim()) {
      throw new Error("Gemini modelId cannot be empty");
    }

    // Keep the key out of the URL and logs by using Google's supported header.
    // Redirects are disabled so credentials cannot be forwarded to another host.
    const endpoint = `${this.#baseUrl}/models/${encodeURIComponent(request.modelId)}:generateContent`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        ...(options.signal ? { signal: options.signal } : {}),
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.#apiKey,
        },
        body: JSON.stringify(buildGeminiRequest(request)),
      });
    } catch (error) {
      throw normalizeModelError({ provider: this.provider, error });
    }

    if (!response.ok) {
      throw normalizeModelError({
        provider: this.provider,
        error: new Error(`Gemini request failed with status ${response.status}`),
        status: response.status,
      });
    }

    try {
      return parseGeminiResponse(await response.json());
    } catch (error) {
      throw normalizeModelError({ provider: this.provider, error });
    }
  }
}

/** Restricts Gemini credentials to Google's official generateContent API root. */
function validateGeminiBaseUrl(value: string): string {
  const url = new URL(value);
  const valid = url.protocol === "https:"
    && url.hostname === "generativelanguage.googleapis.com"
    && (url.port === "" || url.port === "443")
    && url.username === ""
    && url.password === ""
    && (url.pathname === "/v1beta" || url.pathname === "/v1beta/")
    && url.search === ""
    && url.hash === "";

  if (!valid) {
    throw new Error(`Gemini baseUrl must be the official HTTPS API root: ${GEMINI_API_ROOT}`);
  }
  return GEMINI_API_ROOT;
}
