import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelRequest } from "../src/models/model-protocol.js";
import { OpenAICompatibleProvider } from "../src/models/openai-compatible-provider.js";

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

describe("OpenAICompatibleProvider", () => {
  it("maps neutral messages, tool calls, results, and definitions to Chat Completions", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body?: string }) => {
      expect(JSON.parse(init.body ?? "{}")).toEqual({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: "Read a file" },
          {
            role: "assistant",
            content: "I will read it.",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"a.txt\"}",
                },
              },
            ],
          },
          {
            role: "tool",
            content: "file contents",
            tool_call_id: "call-1",
            name: "read_file",
          },
        ],
        max_tokens: 256,
        temperature: 0.2,
        response_format: { type: "json_object" },
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read one file",
              parameters: { type: "object" },
            },
          },
        ],
      });

      return createResponse({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const provider = new OpenAICompatibleProvider({
      provider: "deepseek",
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.test/v1",
    });
    const request: ModelRequest = {
      modelId: "deepseek-chat",
      maxTokens: 256,
      temperature: 0.2,
      responseFormat: "json",
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
      stopReason: "stop",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
        },
      }),
    );
  });

  it("parses text, tool calls, usage, refusal, and the finish reason", async () => {
    const fetchMock = vi.fn(async () => createResponse({
      choices: [
        {
          message: {
            content: null,
            refusal: "cannot comply",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "echo", arguments: "{\"value\":\"hi\"}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const provider = new OpenAICompatibleProvider({ apiKey: "test-key" });

    await expect(provider.generate({ modelId: "gpt-test", messages: [] })).resolves.toEqual({
      text: "",
      toolCalls: [{ id: "call-1", name: "echo", input: { value: "hi" } }],
      stopReason: "tool_calls",
      refusal: "cannot comply",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
  });

  it("supports vendor API roots and complete Chat Completions endpoints", async () => {
    const fetchMock = vi.fn(async () => createResponse({
      choices: [{ message: { content: "ok" } }],
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const kimi = new OpenAICompatibleProvider({
      provider: "kimi",
      apiKey: "test-key",
      baseUrl: "https://api.moonshot.test/v1/",
    });
    const glm = new OpenAICompatibleProvider({
      provider: "glm",
      apiKey: "test-key",
      baseUrl: "https://open.bigmodel.test/api/paas/v4/chat/completions",
    });

    await kimi.generate({ modelId: "moonshot-test", messages: [] });
    await glm.generate({ modelId: "glm-test", messages: [] });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.moonshot.test/v1/chat/completions");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://open.bigmodel.test/api/paas/v4/chat/completions",
    );
  });

  it("reports non-success HTTP responses without parsing them as model output", async () => {
    const fetchMock = vi.fn(async () => createResponse({ error: "rate limited" }, 429));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const provider = new OpenAICompatibleProvider({
      provider: "deepseek",
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.test/v1",
    });

    await expect(provider.generate({ modelId: "deepseek-chat", messages: [] })).rejects.toThrow(
      "deepseek OpenAI-compatible request failed with status 429",
    );
  });

  it("rejects malformed successful responses and invalid tool argument JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createResponse({ choices: [] }))
      .mockResolvedValueOnce(createResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call-1",
              function: { name: "echo", arguments: "not-json" },
            }],
          },
        }],
      }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const provider = new OpenAICompatibleProvider({ apiKey: "test-key" });
    const request = { modelId: "gpt-test", messages: [] } satisfies ModelRequest;

    await expect(provider.generate(request)).rejects.toThrow(
      "openai returned an invalid OpenAI-compatible response: choices must be a non-empty array",
    );
    await expect(provider.generate(request)).rejects.toThrow(
      "openai returned an invalid OpenAI-compatible response: tool_calls[0].function.arguments contains invalid JSON",
    );
  });

  it("requires credentials and rejects unsafe endpoint URLs", async () => {
    const provider = new OpenAICompatibleProvider({
      provider: "vendor-without-key",
      baseUrl: "https://vendor.test/v1",
    });

    await expect(provider.generate({ modelId: "test", messages: [] })).rejects.toThrow(
      "vendor-without-key apiKey is required in config or VENDOR_WITHOUT_KEY_API_KEY",
    );
    expect(() => new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "http://openai.test/v1",
    })).toThrow("OpenAI-compatible baseUrl must be an HTTPS URL without credentials or a hash");
  });
});
