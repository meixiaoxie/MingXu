import { afterEach, describe, expect, it, vi } from "vitest";

import { GeminiProvider } from "../src/models/gemini-provider.js";
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

describe("GeminiProvider", () => {
  it("maps neutral messages and tools into generateContent format", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body?: string }) => {
      expect(JSON.parse(init.body ?? "{}")).toEqual({
        systemInstruction: { parts: [{ text: "Be concise" }] },
        contents: [
          { role: "user", parts: [{ text: "Read it" }] },
          {
            role: "model",
            parts: [
              { text: "Working" },
              { functionCall: { name: "read_file", args: { path: "a.txt" } } },
            ],
          },
          {
            role: "user",
            parts: [{
              functionResponse: {
                name: "read_file",
                response: { output: "contents", isError: false },
              },
            }],
          },
        ],
        tools: [{ functionDeclarations: [{
          name: "read_file",
          description: "Read one file",
          parameters: { type: "object" },
        }] }],
        generationConfig: { maxOutputTokens: 256, temperature: 0.2 },
      });
      return createResponse({
        candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const request: ModelRequest = {
      modelId: "gemini-2.5-flash",
      system: "Be concise",
      maxTokens: 256,
      temperature: 0.2,
      messages: [
        { role: "user", content: "Read it" },
        {
          role: "assistant",
          content: "Working",
          toolCalls: [{ id: "call-1", name: "read_file", input: { path: "a.txt" } }],
        },
        { role: "tool", content: "contents", toolCallId: "call-1", name: "read_file" },
      ],
      tools: [{ name: "read_file", description: "Read one file", inputSchema: { type: "object" } }],
    };

    const provider = new GeminiProvider({ apiKey: "test-key" });
    await expect(provider.generate(request)).resolves.toEqual({
      text: "done",
      toolCalls: [],
      stopReason: "STOP",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": "test-key",
        },
      }),
    );
  });

  it("parses text, function calls, finish reason, and usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => createResponse({
      candidates: [{
        content: { parts: [
          { text: "First" },
          { functionCall: { name: "echo", args: { value: "hi" } } },
          { text: "Second" },
        ] },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
        cachedContentTokenCount: 3,
      },
    })) as unknown as typeof fetch);

    const provider = new GeminiProvider({ apiKey: "test-key" });
    await expect(provider.generate({ modelId: "gemini-test", messages: [] })).resolves.toEqual({
      text: "First\nSecond",
      toolCalls: [{ id: "gemini-call-0-1", name: "echo", input: { value: "hi" } }],
      stopReason: "STOP",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheReadTokens: 3 },
    });
  });

  it("reports HTTP failures and rejects unofficial API roots", async () => {
    expect(() => new GeminiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1beta",
    })).toThrow("Gemini baseUrl must be the official HTTPS API root");

    vi.stubGlobal("fetch", vi.fn(async () => createResponse({}, 429)) as unknown as typeof fetch);
    const provider = new GeminiProvider({ apiKey: "test-key" });
    await expect(provider.generate({ modelId: "gemini-test", messages: [] })).rejects.toThrow(
      "Gemini request failed with status 429",
    );
  });

  it("rejects malformed successful responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => createResponse({ candidates: [] })) as unknown as typeof fetch);
    const provider = new GeminiProvider({ apiKey: "test-key" });
    await expect(provider.generate({ modelId: "gemini-test", messages: [] })).rejects.toThrow(
      "Gemini returned an invalid response: candidates must be a non-empty array",
    );
  });
});
