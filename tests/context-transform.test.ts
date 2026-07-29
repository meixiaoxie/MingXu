import { describe, expect, it } from "vitest";
import { defaultConvertToLlm, defaultTransformContext } from "../src/core/context.js";
import type { AgentMessage } from "../src/core/messages.js";

describe("context transform", () => {
  it("不裁剪消息——原样返回", () => {
    const messages: AgentMessage[] = [
      { id: "u1", role: "user", content: "hi", createdAt: "now" },
    ];
    // defaultTransformContext 是最简单的"什么都不做"的默认实现
    expect(defaultTransformContext(messages)).toEqual(messages);
  });

  it("把 summary 转成带前缀的 user 消息发给模型", () => {
    const input = defaultConvertToLlm({
      messages: [
        { id: "s1", role: "summary", content: "Old facts", createdAt: "now" },
        { id: "u1", role: "user", content: "Continue", createdAt: "now" },
      ],
      tools: [],
    });

    expect(input.messages).toHaveLength(2);
    // 摘要消息必须带上标记前缀，让模型知道这些不是当前对话
    expect(input.messages[0]!.content).toContain("Previous conversation summary");
  });

  it("不把 visibleToModel=false 的系统消息发给模型", () => {
    const input = defaultConvertToLlm({
      messages: [
        {
          id: "sys1",
          role: "system",
          content: "debug info",
          createdAt: "now",
          visibleToModel: false,
        },
        { id: "u1", role: "user", content: "test", createdAt: "now" },
      ],
      tools: [],
    });

    // 不可见的系统消息被过滤掉了，只剩下一条 user 消息
    expect(input.messages).toHaveLength(1);
  });

  it("把 toolResult 的输出序列化为字符串", () => {
    const input = defaultConvertToLlm({
      messages: [
        {
          id: "tr1",
          role: "toolResult",
          content: "ok",
          createdAt: "now",
          toolResult: {
            toolCallId: "tc1",
            name: "echo",
            output: { echoed: "hello" },
          },
        },
      ],
      tools: [],
    });

    expect(input.messages).toHaveLength(1);
    // 工具输出是对象，序列化后应该变成 JSON 字符串
    expect(input.messages[0]!.content).toBe('{"echoed":"hello"}');
  });

  it("把 visibleToModel=true 的系统消息转为 user 消息发给模型", () => {
    const input = defaultConvertToLlm({
      messages: [
        {
          id: "sys1",
          role: "system",
          content: "important system info",
          createdAt: "now",
          visibleToModel: true,
        },
        { id: "u1", role: "user", content: "hello", createdAt: "now" },
      ],
      tools: [],
    });

    expect(input.messages).toHaveLength(2);
    expect(input.messages[0]!.role).toBe("user");
    expect(input.messages[0]!.content).toBe("important system info");
  });
});
