import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomProvider } from "../src/models/custom-provider.js";
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

describe("CustomProvider", () => {
  it("requires an HTTPS endpoint and defaults to the openai-compatible protocol", () => {
    expect(() => new CustomProvider({ baseUrl: "http://localhost/v1/chat/completions" })).toThrow(
      "Custom provider baseUrl must be an HTTPS endpoint",
    );
    const provider = new CustomProvider({ baseUrl: "https://models.example.test/v1/chat/completions" });
    expect(provider.protocol).toBe("openai-compatible");
  });

  it("locks its request contract to OpenAI-compatible chat completions", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body?: string }) => {
      expect(JSON.parse(init.body ?? "{}")).toEqual({
        model: "private-model",
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: "Use the tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: { name: "echo", arguments: "{\"value\":\"hi\"}" },
            }],
          },
          { role: "tool", content: "hi", tool_call_id: "call-1" },
        ],
        tools: [{
          type: "function",
          function: {
            name: "echo",
            description: "Echo input",
            parameters: { type: "object" },
          },
        }],
        max_tokens: 100,
        response_format: { type: "json_object" },
      });
      return createResponse({
        choices: [{
          message: {
            content: "done",
            tool_calls: [{
              id: "call-2",
              function: { name: "echo", arguments: "{\"value\":\"again\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const request: ModelRequest = {
      modelId: "private-model",
      system: "Be concise",
      maxTokens: 100,
      responseFormat: "json",
      messages: [
        { role: "user", content: "Use the tool" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "echo", input: { value: "hi" } }],
        },
        { role: "tool", content: "hi", toolCallId: "call-1", name: "echo" },
      ],
      tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object" } }],
    };

    const provider = new CustomProvider({
      protocol: "openai-compatible",
      baseUrl: "https://models.example.test/v1/chat/completions",
      apiKey: "secret",
    });
    await expect(provider.generate(request)).resolves.toEqual({
      text: "done",
      toolCalls: [{ id: "call-2", name: "echo", input: { value: "again" } }],
      stopReason: "tool_calls",
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret",
        },
      }),
    );
  });

  it("reports HTTP failures without exposing response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => createResponse({ secret: "body" }, 503)) as unknown as typeof fetch);
    const provider = new CustomProvider({ baseUrl: "https://models.example.test/v1/chat/completions" });

    await expect(provider.generate({ modelId: "private-model", messages: [] })).rejects.toThrow(
      "Custom provider request failed with status 503",
    );
  });

  it("rejects malformed responses and invalid tool argument JSON", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createResponse({ choices: [] }))
      .mockResolvedValueOnce(createResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: "call-1", function: { name: "echo", arguments: "not-json" } }],
          },
        }],
      }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = new CustomProvider({ baseUrl: "https://models.example.test/v1/chat/completions" });

    await expect(provider.generate({ modelId: "private-model", messages: [] })).rejects.toThrow(
      "choices must be a non-empty array",
    );
    await expect(provider.generate({ modelId: "private-model", messages: [] })).rejects.toThrow(
      "invalid JSON arguments for tool echo",
    );
  });
});
