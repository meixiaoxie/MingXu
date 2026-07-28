import { describe, expect, it, vi } from "vitest";

import {
  AnthropicProvider,
  type HttpClient,
} from "../src/models/index.js";

function createResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("AnthropicProvider", () => {
  it("converts neutral input into an Anthropic Messages request", async () => {
    const httpClient = vi.fn<HttpClient>().mockResolvedValue(createResponse({
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
    }));
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-test",
      maxTokens: 256,
      httpClient,
    });

    await provider.generate({
      systemPrompt: "Be concise",
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
          toolResult: { toolCallId: "call-1", name: "read_file", output: "file contents" },
        },
      ],
      tools: [{
        name: "read_file",
        description: "Read one file",
        inputSchema: { type: "object" },
      }],
    });

    expect(httpClient).toHaveBeenCalledOnce();
    const [url, request] = httpClient.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(request.body)).toEqual({
      model: "claude-test",
      max_tokens: 256,
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
          content: [{
            type: "tool_result",
            tool_use_id: "call-1",
            content: "file contents",
            is_error: false,
          }],
        },
      ],
      system: "Be concise",
      tools: [{
        name: "read_file",
        description: "Read one file",
        input_schema: { type: "object" },
      }],
    });
  });

  it("parses text and tool-use blocks into neutral model output", async () => {
    const httpClient: HttpClient = async () => createResponse({
      content: [
        { type: "text", text: "First" },
        { type: "tool_use", id: "call-1", name: "echo", input: { value: "hi" } },
        { type: "text", text: "Second" },
      ],
      stop_reason: "tool_use",
    });
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-test",
      httpClient,
    });

    await expect(provider.generate({
      messages: [{ role: "user", content: "hello" }],
    })).resolves.toEqual({
      content: "First\nSecond",
      toolCalls: [{ id: "call-1", name: "echo", input: { value: "hi" } }],
      stopReason: "tool_use",
    });
  });

  it("uses a custom endpoint and reports unsuccessful HTTP responses", async () => {
    const httpClient = vi.fn<HttpClient>().mockResolvedValue(createResponse({}, 429));
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-test",
      baseUrl: "https://example.test/messages",
      httpClient,
    });

    await expect(provider.generate({ messages: [] })).rejects.toThrow(
      "Anthropic request failed with status 429",
    );
    expect(httpClient).toHaveBeenCalledWith(
      "https://example.test/messages",
      expect.any(Object),
    );
  });

  it("rejects malformed successful responses", async () => {
    const httpClient: HttpClient = async () => createResponse({ content: "invalid" });
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-test",
      httpClient,
    });

    await expect(provider.generate({ messages: [] })).rejects.toThrow(
      "Anthropic returned an invalid response: content must be an array",
    );
  });
});
