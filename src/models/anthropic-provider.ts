import { z } from "zod";

import { normalizeModelError } from "./execution-errors.js";
import { defaultModelCapabilities } from "./model-capabilities.js";
import { resolveProviderSecret } from "./provider-env.js";
import { parseSseStream } from "./sse.js";
import type { ModelExecutionOptions, ModelAdapter } from "./provider-registry.js";
import type { ModelEvent, ModelRequest, ModelResponse, ModelToolCall } from "./model-protocol.js";

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
    this.#apiKey = resolveProviderSecret(parsed.apiKey, "ANTHROPIC_API_KEY");
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

  async *stream(request: ModelRequest, options: ModelExecutionOptions = {}): AsyncIterable<ModelEvent> {
    if (!this.#apiKey) {
      throw new Error("Anthropic apiKey is required in config or ANTHROPIC_API_KEY");
    }

    const requestBody = {
      model: request.modelId,
      max_tokens: request.maxTokens ?? 1024,
      stream: true,
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
    };

    let response: Response;
    try {
      response = await fetch(this.#baseUrl, {
        method: "POST",
        redirect: "error",
        ...(options.signal ? { signal: options.signal } : {}),
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-api-key": this.#apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      yield createStreamErrorEvent(this.provider, error);
      throw normalizeModelError({ provider: this.provider, error });
    }

    if (!response.ok) {
      const error = new Error(`Anthropic request failed with status ${response.status}`);
      yield createStreamErrorEvent(this.provider, error, { status: response.status });
      throw normalizeModelError({
        provider: this.provider,
        error,
        status: response.status,
      });
    }

    yield { type: "start", request };

    try {
      const state = createAnthropicStreamState();
      for await (const event of parseSseStream(response.body, options.signal)) {
        if (!event.data || event.data === "[DONE]") {
          if (event.data === "[DONE]") break;
          continue;
        }

        const payload = JSON.parse(event.data) as AnthropicStreamChunk;
        for (const modelEvent of consumeAnthropicStreamChunk(payload, state)) {
          yield modelEvent;
        }
      }

      yield {
        type: "end",
        response: {
          text: state.text,
          toolCalls: finalizeAnthropicToolCalls(state.toolBlocks),
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

interface AnthropicStreamChunk {
  type?: unknown;
  message?: {
    id?: unknown;
  };
  index?: unknown;
  content_block?: {
    type?: unknown;
    id?: unknown;
    name?: unknown;
    input?: unknown;
  };
  delta?: {
    type?: unknown;
    text?: unknown;
    partial_json?: unknown;
    stop_reason?: unknown;
  };
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
}

interface AnthropicToolBlockState {
  readonly index: number;
  id?: string;
  name?: string;
  inputJson: string;
  input?: unknown;
  emitted?: boolean;
}

interface AnthropicStreamState {
  text: string;
  stopReason?: string;
  usage?: ModelResponse["usage"];
  toolBlocks: Map<number, AnthropicToolBlockState>;
}

function createAnthropicStreamState(): AnthropicStreamState {
  return {
    text: "",
    toolBlocks: new Map<number, AnthropicToolBlockState>(),
  };
}

function consumeAnthropicStreamChunk(
  chunk: AnthropicStreamChunk,
  state: AnthropicStreamState,
): ModelEvent[] {
  const events: ModelEvent[] = [];
  switch (chunk.type) {
    case "message_delta":
      if (typeof chunk.delta?.stop_reason === "string") {
        state.stopReason = chunk.delta.stop_reason;
      }
      if (chunk.usage) {
        state.usage = parseAnthropicUsage(chunk.usage) ?? state.usage;
      }
      return events;
    case "content_block_start":
      handleAnthropicContentBlockStart(chunk, state);
      return events;
    case "content_block_delta":
      handleAnthropicContentBlockDelta(chunk, state, events);
      return events;
    case "content_block_stop":
      handleAnthropicContentBlockStop(chunk, state, events);
      return events;
    case "message_stop":
      finalizeAnthropicToolBlocks(state.toolBlocks, events);
      return events;
    case "message_start":
    case "ping":
      return events;
    default:
      return events;
  }
}

function handleAnthropicContentBlockStart(chunk: AnthropicStreamChunk, state: AnthropicStreamState): void {
  const index = normalizeAnthropicIndex(chunk.index);
  const block = chunk.content_block;
  if (!block || typeof block !== "object") {
    return;
  }

  const existing = state.toolBlocks.get(index) ?? {
    index,
    inputJson: "",
  };
  if (typeof block.id === "string") {
    existing.id = block.id;
  }
  if (typeof block.name === "string") {
    existing.name = block.name;
  }
  if ("input" in block && block.input !== undefined) {
    existing.input = block.input;
  }
  state.toolBlocks.set(index, existing);
}

function handleAnthropicContentBlockDelta(
  chunk: AnthropicStreamChunk,
  state: AnthropicStreamState,
  events: ModelEvent[],
): void {
  const index = normalizeAnthropicIndex(chunk.index);
  const block = state.toolBlocks.get(index) ?? { index, inputJson: "" };
  const delta = chunk.delta;
  if (!delta || typeof delta !== "object") {
    return;
  }

  if (delta.type === "text_delta" && typeof delta.text === "string") {
    state.text += delta.text;
    events.push({ type: "delta", text: delta.text });
  }

  if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
    block.inputJson += delta.partial_json;
    state.toolBlocks.set(index, block);
  }
}

function handleAnthropicContentBlockStop(
  chunk: AnthropicStreamChunk,
  state: AnthropicStreamState,
  events: ModelEvent[],
): void {
  const index = normalizeAnthropicIndex(chunk.index);
  const block = state.toolBlocks.get(index);
  if (!block || block.emitted || !block.name) {
    return;
  }

  block.emitted = true;
  const toolCall = {
    id: block.id ?? `anthropic-tool-call-${index}`,
    name: block.name,
    input: block.input ?? parseAnthropicToolInput(block.inputJson),
  } satisfies ModelToolCall;
  state.toolBlocks.set(index, block);
  events.push({ type: "tool_call", toolCall });
}

function finalizeAnthropicToolBlocks(
  blocks: Map<number, AnthropicToolBlockState>,
  events: ModelEvent[],
): void {
  for (const block of blocks.values()) {
    if (block.emitted || !block.name) {
      continue;
    }
    block.emitted = true;
    const toolCall = {
      id: block.id ?? `anthropic-tool-call-${block.index}`,
      name: block.name,
      input: block.input ?? parseAnthropicToolInput(block.inputJson),
    } satisfies ModelToolCall;
    events.push({ type: "tool_call", toolCall });
  }
}

function parseAnthropicToolInput(value: string): unknown {
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

function parseAnthropicUsage(value: AnthropicStreamChunk["usage"]): ModelResponse["usage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value;
  const result = {
    ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    ...(
      typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
        ? { totalTokens: usage.input_tokens + usage.output_tokens }
        : {}
    ),
    ...(typeof usage.cache_read_input_tokens === "number"
      ? { cacheReadTokens: usage.cache_read_input_tokens }
      : {}),
    ...(typeof usage.cache_creation_input_tokens === "number"
      ? { cacheWriteTokens: usage.cache_creation_input_tokens }
      : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function finalizeAnthropicToolCalls(blocks: Map<number, AnthropicToolBlockState>): ModelToolCall[] {
  return [...blocks.values()]
    .sort((left, right) => left.index - right.index)
    .filter((block) => Boolean(block.name))
    .map((block) => ({
      id: block.id ?? `anthropic-tool-call-${block.index}`,
      name: block.name ?? "tool",
      input: block.input ?? parseAnthropicToolInput(block.inputJson),
    }));
}

function normalizeAnthropicIndex(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function createStreamErrorEvent(provider: string, error: unknown, extra?: Record<string, unknown>): ModelEvent {
  return {
    type: "error",
    error: error instanceof Error ? error.message : String(error),
    ...(extra !== undefined ? { rawProviderData: { provider, ...extra } } : { rawProviderData: { provider } }),
  };
}
