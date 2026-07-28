import { describe, expect, it } from "vitest";
import { createGenerateFallbackStreamFn } from "../src/index.js";

describe("generate fallback streamFn", () => {
  it("把 generate 输出包装成完整的流式事件序列", async () => {
    const streamFn = createGenerateFallbackStreamFn({
      async generate() {
        return {
          content: "hello",
          toolCalls: [{ id: "call-1", name: "echo", input: { message: "x" } }],
        };
      },
    });

    const events: string[] = [];
    for await (const event of await streamFn("test", { messages: [], tools: [] })) {
      events.push(event.type);
    }

    // 事件顺序必须保证：start 最先，done 最后
    expect(events[0]).toBe("start");
    expect(events).toContain("text_delta");
    expect(events).toContain("tool_call");
    expect(events[events.length - 1]).toBe("done");
  });

  it("在开始时就检查 abort signal", async () => {
    const controller = new AbortController();
    // 先 abort 再调用——此时应该直接返回 error 事件，不会调模型
    controller.abort();

    const streamFn = createGenerateFallbackStreamFn({
      async generate() {
        return { content: "x", toolCalls: [] };
      },
    });

    const events = [];
    for await (const event of await streamFn(
      "test",
      { messages: [], tools: [] },
      { signal: controller.signal },
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
  });
});
