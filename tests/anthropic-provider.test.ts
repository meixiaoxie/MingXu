import { afterEach, describe, expect, it, vi } from "vitest";

import { AnthropicProvider } from "../src/models/index.js";
import type { ModelRequest } from "../src/models/model-protocol.js";

function createResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AnthropicProvider", () => {
  it("converts neutral input into an Anthropic Messages request", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body?: string }) => {
      expect(JSON.parse(init.body ?? "{}")).toMatchObject({
        model: "claude-test",
        max_tokens: 256,
        system: "Be concise",
        messages: [
          { role: "user", content: "Read a file" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "I will read it." },
              { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.txt" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                content: "file contents",
                is_error: false,
              },
            ],
          },
        ],
        tools: [
          {
            name: "read_file",
            description: "Read one file",
            input_schema: { type: "object" },
          },
        ],
      });

      return createResponse({
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const provider = new AnthropicProvider({
      apiKey: "test-key",
    });
    const request: ModelRequest = {
      modelId: "claude-test",
      maxTokens: 256,
      system: "Be concise",
      messages: [
        { role: "user", content: "Read a file" },
        {
          role: "assistant",
          content: "I will read it.",
          toolCalls: [{ id: "call-1", name: "read_file", input: { path: "a.txt" } }],
        },
        {
          role: "tool",
          content: "file contents",
          toolCallId: "call-1",
          name: "read_file",
          isError: false,
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read one file",
          inputSchema: { type: "object" },
        },
      ],
    };

    await expect(provider.generate(request)).resolves.toEqual({
      text: "done",
      toolCalls: [],
      stopReason: "end_turn",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
      }),
    );
  });

  it("parses text and tool-use blocks into neutral model output", async () => {
    const fetchMock = vi.fn(async () => createResponse({
      content: [
        { type: "text", text: "First" },
        { type: "tool_use", id: "call-1", name: "echo", input: { value: "hi" } },
        { type: "text", text: "Second" },
      ],
      stop_reason: "tool_use",
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const provider = new AnthropicProvider({
      apiKey: "test-key",
    });

    await expect(provider.generate({ modelId: "claude-test", messages: [] })).resolves.toEqual({
      text: "First\nSecond",
      toolCalls: [{ id: "call-1", name: "echo", input: { value: "hi" } }],
      stopReason: "tool_use",
    });
  });

  it("uses the official endpoint and rejects non-official custom base URLs", async () => {
    expect(() => new AnthropicProvider({ apiKey: "test-key", baseUrl: "https://example.test/messages" })).toThrow(
      "Anthropic baseUrl must be the official HTTPS Messages endpoint: https://api.anthropic.com/v1/messages",
    );

    const fetchMock = vi.fn(async () => createResponse({}, 429));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const provider = new AnthropicProvider({ apiKey: "test-key" });

    await expect(provider.generate({ modelId: "claude-test", messages: [] })).rejects.toThrow(
      "Anthropic request failed with status 429",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.any(Object),
    );
  });

  it("rejects malformed successful responses", async () => {
    const fetchMock = vi.fn(async () => createResponse({ content: "invalid" }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const provider = new AnthropicProvider({
      apiKey: "test-key",
    });

    await expect(provider.generate({ modelId: "claude-test", messages: [] })).rejects.toThrow(
      "Anthropic returned an invalid response: content must be an array",
    );
  });
});
