import { z } from "zod";

import { withExecutionSignal } from "../core/execution-signal.js";
import { normalizeModelError } from "./execution-errors.js";
import { defaultModelCapabilities } from "./model-capabilities.js";
import { buildGeminiRequest, parseGeminiResponse } from "./gemini-format.js";
import { parseSseStream } from "./sse.js";
import { resolveProviderSecret } from "./provider-env.js";
import type { ModelExecutionOptions, ModelAdapter } from "./provider-registry.js";
import type { ModelEvent, ModelRequest, ModelResponse, ModelToolCall } from "./model-protocol.js";

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
    this.#apiKey = resolveProviderSecret(parsed.apiKey, "GEMINI_API_KEY");
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

  async *stream(request: ModelRequest, options: ModelExecutionOptions = {}): AsyncIterable<ModelEvent> {
    if (!this.#apiKey) {
      throw new Error("Gemini apiKey is required in config or GEMINI_API_KEY");
    }
    if (!request.modelId.trim()) {
      throw new Error("Gemini modelId cannot be empty");
    }

    const endpoint = `${this.#baseUrl}/models/${encodeURIComponent(request.modelId)}:streamGenerateContent?alt=sse`;
    const requestBody = buildGeminiRequest(request);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        ...(options.signal ? { signal: options.signal } : {}),
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-goog-api-key": this.#apiKey,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      yield createStreamErrorEvent(this.provider, error);
      throw normalizeModelError({ provider: this.provider, error });
    }

    if (!response.ok) {
      const error = new Error(`Gemini request failed with status ${response.status}`);
      yield createStreamErrorEvent(this.provider, error, { status: response.status });
      throw normalizeModelError({
        provider: this.provider,
        error,
        status: response.status,
      });
    }

    yield { type: "start", request };

    try {
      const state = createGeminiStreamState();
      for await (const event of parseSseStream(response.body, options.signal)) {
        if (!event.data || event.data === "[DONE]") {
          if (event.data === "[DONE]") break;
          continue;
        }

        const payload = JSON.parse(event.data) as GeminiStreamChunk;
        for (const modelEvent of consumeGeminiStreamChunk(payload, state)) {
          yield modelEvent;
        }
      }

      yield {
        type: "end",
        response: {
          text: state.text,
          toolCalls: finalizeGeminiToolCalls(state.toolCalls),
          ...(state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
          ...(state.usage !== undefined ? { usage: state.usage } : {}),
        },
      };
    } catch (error) {
      yield createStreamErrorEvent(this.provider, error);
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

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: unknown;
    };
    finishReason?: unknown;
  }>;
  usageMetadata?: unknown;
}

interface GeminiToolCallState {
  readonly index: number;
  id: string;
  name: string;
  input: unknown;
}

interface GeminiStreamState {
  text: string;
  stopReason?: string;
  usage?: ModelResponse["usage"];
  toolCalls: Map<number, GeminiToolCallState>;
}

function createGeminiStreamState(): GeminiStreamState {
  return {
    text: "",
    toolCalls: new Map<number, GeminiToolCallState>(),
  };
}

function consumeGeminiStreamChunk(
  chunk: GeminiStreamChunk,
  state: GeminiStreamState,
): ModelEvent[] {
  const events: ModelEvent[] = [];
  const candidate = chunk.candidates?.[0];
  if (!candidate) {
    state.usage = parseGeminiUsage(chunk.usageMetadata) ?? state.usage;
    return events;
  }

  const parts = candidate.content?.parts;
  if (Array.isArray(parts)) {
    for (const [partIndex, rawPart] of parts.entries()) {
      if (!rawPart || typeof rawPart !== "object") {
        continue;
      }
      const part = rawPart as { text?: unknown; functionCall?: unknown };
      if (typeof part.text === "string") {
        state.text += part.text;
        events.push({ type: "delta", text: part.text });
      }
      if (part.functionCall !== undefined) {
        const call = part.functionCall as { name?: unknown; args?: unknown };
        if (typeof call.name !== "string" || !call.name) {
          throw new Error("Gemini returned an invalid stream response: functionCall.name must be a string");
        }
        const toolCall = {
          id: `gemini-call-0-${partIndex}`,
          name: call.name,
          input: call.args ?? {},
        } satisfies ModelToolCall;
        state.toolCalls.set(partIndex, {
          index: partIndex,
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        });
        events.push({ type: "tool_call", toolCall });
      }
    }
  }

  if (typeof candidate.finishReason === "string") {
    state.stopReason = candidate.finishReason;
  }
  state.usage = parseGeminiUsage(chunk.usageMetadata) ?? state.usage;
  return events;
}

function finalizeGeminiToolCalls(blocks: Map<number, GeminiToolCallState>): ModelToolCall[] {
  return [...blocks.values()]
    .sort((left, right) => left.index - right.index)
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input,
    }));
}

function parseGeminiUsage(value: unknown): ModelResponse["usage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    totalTokenCount?: unknown;
    cachedContentTokenCount?: unknown;
  };
  const result = {
    ...(typeof usage.promptTokenCount === "number" ? { inputTokens: usage.promptTokenCount } : {}),
    ...(typeof usage.candidatesTokenCount === "number" ? { outputTokens: usage.candidatesTokenCount } : {}),
    ...(typeof usage.totalTokenCount === "number" ? { totalTokens: usage.totalTokenCount } : {}),
    ...(typeof usage.cachedContentTokenCount === "number" ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
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
