import { describe, expect, it } from "vitest";
import { createRuntimeStreamFn } from "../src/index.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/index.js";

describe("model stream bridge", () => {
  it("把 ModelEvent stream 正确转换为 AssistantStreamEvent", async () => {
    const adapter: ModelAdapter = {
      provider: "test",
      capabilities: {
        supportsTools: true,
        supportsStreaming: true,
        supportsImages: false,
        supportsStructuredOutput: false,
        supportsRefusal: false,
        supportsFallback: false,
        supportsEffort: false,
        supportsPromptCaching: false,
        supportsMidConversationSystem: false,
        maxContext: 100000,
        maxOutput: 4096,
      },
      async generate() {
        throw new Error("not used");
      },
      async *stream() {
        yield { type: "start", request: {} as ModelRequest };
        yield { type: "delta", text: "hi" };
        yield {
          type: "end",
          response: { text: "hi", toolCalls: [] },
        };
      },
    };

    const streamFn = createRuntimeStreamFn(adapter, {
      provider: "test",
      model: "m",
    });
    const events = [];
    for await (const event of await streamFn("m", {
      messages: [],
      tools: [],
    })) {
      events.push(event.type);
    }

    expect(events).toEqual(["start", "text_delta", "done"]);
  });

  it("当 adapter 没有 stream 时自动走 generate fallback", async () => {
    const adapter: ModelAdapter = {
      provider: "test",
      capabilities: {
        supportsTools: false,
        supportsStreaming: false,
        supportsImages: false,
        supportsStructuredOutput: false,
        supportsRefusal: false,
        supportsFallback: false,
        supportsEffort: false,
        supportsPromptCaching: false,
        supportsMidConversationSystem: false,
        maxContext: 100000,
        maxOutput: 4096,
      },
      async generate() {
        return { text: "fallback", toolCalls: [] };
      },
    };

    const streamFn = createRuntimeStreamFn(adapter, {
      provider: "test",
      model: "m",
    });
    const events = [];
    for await (const event of await streamFn("m", {
      messages: [],
      tools: [],
    })) {
      events.push(event.type);
    }

    expect(events).toContain("done");
    expect(events).toContain("start");
  });
});
