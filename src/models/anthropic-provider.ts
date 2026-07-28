import { z } from "zod";

import { defaultModelCapabilities } from "./model-capabilities.js";
import { readProviderEnv } from "./provider-env.js";
import type { ModelAdapter } from "./provider-registry.js";
import type { ModelRequest, ModelResponse, ModelToolCall } from "./model-protocol.js";

const anthropicInputSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
});

interface AnthropicProviderOptions {
  apiKey?: string;
  baseUrl?: string;
}

interface AnthropicBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  stop_reason?: unknown;
  content?: unknown;
}

export class AnthropicProvider implements ModelAdapter {
  readonly provider = "anthropic";
  readonly capabilities = defaultModelCapabilities;
  readonly #apiKey?: string;
  readonly #baseUrl: string;

  constructor(options: AnthropicProviderOptions = {}) {
    const parsed = anthropicInputSchema.parse(options);
    this.#apiKey = parsed.apiKey?.trim() || readProviderEnv("ANTHROPIC_API_KEY");
    this.#baseUrl = parsed.baseUrl ?? "https://api.anthropic.com/v1/messages";
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (!this.#apiKey) {
      throw new Error("Anthropic apiKey is required in config or ANTHROPIC_API_KEY");
    }

    const response = await fetch(this.#baseUrl, {
      method: "POST",
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

    if (!response.ok) {
      throw new Error(`Anthropic request failed with status ${response.status}`);
    }

    return parseAnthropicResponse(await response.json());
  }
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
  };
}
