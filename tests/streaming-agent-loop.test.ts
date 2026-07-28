import { describe, expect, it } from "vitest";
import { runStreamingAgentLoop, defineTool } from "../src/index.js";
import { z } from "zod";
import type { AgentMessage, AssistantStreamEvent } from "../src/index.js";

/** 辅助：创建单轮文本回复的流 */
function textStream(
  messageId: string,
  text: string,
): () => AsyncGenerator<AssistantStreamEvent> {
  return async function* () {
    yield { type: "start", messageId } as AssistantStreamEvent;
    yield { type: "text_delta", text } as AssistantStreamEvent;
    yield {
      type: "done",
      message: {
        id: messageId,
        role: "assistant" as const,
        content: text,
        createdAt: "now",
      },
    } as AssistantStreamEvent;
  };
}

/** 辅助：创建"先调工具再回复"的两轮流 */
function toolThenTextStream(
  firstMsgId: string,
  secondMsgId: string,
  toolCallId: string,
  toolName: string,
  toolInput: unknown,
  finalText: string,
): () => AsyncGenerator<AssistantStreamEvent> {
  let callCount = 0;
  return async function* () {
    callCount++;
    if (callCount === 1) {
      const call = { id: toolCallId, name: toolName, input: toolInput };
      yield { type: "start", messageId: firstMsgId } as AssistantStreamEvent;
      yield {
        type: "tool_call",
        toolCall: call,
      } as AssistantStreamEvent;
      yield {
        type: "done",
        message: {
          id: firstMsgId,
          role: "assistant" as const,
          content: "",
          createdAt: "now",
          toolCalls: [call],
        },
      } as AssistantStreamEvent;
    } else {
      yield { type: "start", messageId: secondMsgId } as AssistantStreamEvent;
      yield { type: "text_delta", text: finalText } as AssistantStreamEvent;
      yield {
        type: "done",
        message: {
          id: secondMsgId,
          role: "assistant" as const,
          content: finalText,
          createdAt: "now",
        },
      } as AssistantStreamEvent;
    }
  };
}

describe("streaming agent loop", () => {
  it("处理纯文本回复——不需要工具调用", async () => {
    const events: string[] = [];
    const result = await runStreamingAgentLoop(
      { userInput: "hi" },
      {
        model: "test",
        streamFn: textStream("a1", "hello"),
        emit: (e) => {
          events.push(e.type);
        },
      },
    );

    expect(result.content).toBe("hello");
    // 验证事件顺序完整
    expect(events).toContain("turn_start");
    expect(events).toContain("message_start");
    expect(events).toContain("message_update");
    expect(events).toContain("message_end");
    expect(events).toContain("turn_end");
  });

  it("先调工具再回复——两轮循环", async () => {
    const tool = defineTool({
      name: "add",
      description: "Adds two numbers",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: ({ a, b }) => a + b,
    });

    const result = await runStreamingAgentLoop(
      { userInput: "1+2=?" },
      {
        model: "test",
        streamFn: toolThenTextStream("a1", "a2", "tc1", "add", { a: 1, b: 2 }, "结果是 3"),
        tools: [tool],
      },
    );

    expect(result.content).toBe("结果是 3");
    expect(result.iterations).toBe(2);
  });

  it("达到 maxIterations 时抛错", async () => {
    async function* streamFn() {
      yield { type: "start" as const, messageId: "a1" } as AssistantStreamEvent;
      yield {
        type: "tool_call" as const,
        toolCall: { id: "tc1", name: "loop", input: {} },
      } as AssistantStreamEvent;
      yield {
        type: "done" as const,
        message: {
          id: "a1",
          role: "assistant" as const,
          content: "",
          createdAt: "now",
          toolCalls: [{ id: "tc1", name: "loop", input: {} }],
        },
      } as AssistantStreamEvent;
    }

    const tool = defineTool({
      name: "loop",
      description: "loops forever",
      inputSchema: z.object({}),
      execute: () => "ok",
    });

    await expect(
      runStreamingAgentLoop(
        { userInput: "go" },
        {
          model: "test",
          streamFn,
          tools: [tool],
          maxIterations: 2,
        },
      ),
    ).rejects.toThrow("maximum");
  });

  it("maxIterations 小于 1 直接报错", async () => {
    await expect(
      runStreamingAgentLoop(
        { userInput: "hi" },
        {
          model: "test",
          streamFn: async function* () {},
          maxIterations: 0,
        },
      ),
    ).rejects.toThrow("maxIterations must be a positive integer");
  });

  it("abort signal 中止 loop", async () => {
    const controller = new AbortController();

    async function* streamFn() {
      controller.abort(); // 在流中立即中止
      yield { type: "start" as const, messageId: "a1" } as AssistantStreamEvent;
      yield { type: "text_delta" as const, text: "..." } as AssistantStreamEvent;
      yield {
        type: "done" as const,
        message: {
          id: "a1",
          role: "assistant" as const,
          content: "...",
          createdAt: "now",
        },
      } as AssistantStreamEvent;
    }

    await expect(
      runStreamingAgentLoop(
        { userInput: "hi" },
        { model: "test", streamFn, signal: controller.signal },
      ),
    ).rejects.toThrow("aborted");
  });

  it("未知工具的报错变成 error toolResult，不崩 loop", async () => {
    let callCount = 0;
    async function* streamFn() {
      callCount++;
      if (callCount === 1) {
        yield { type: "start" as const, messageId: "a1" } as AssistantStreamEvent;
        yield {
          type: "tool_call" as const,
          toolCall: { id: "tc1", name: "nonexistent", input: {} },
        } as AssistantStreamEvent;
        yield {
          type: "done" as const,
          message: {
            id: "a1",
            role: "assistant" as const,
            content: "",
            createdAt: "now",
            toolCalls: [{ id: "tc1", name: "nonexistent", input: {} }],
          },
        } as AssistantStreamEvent;
      } else {
        yield { type: "start" as const, messageId: "a2" } as AssistantStreamEvent;
        yield { type: "text_delta" as const, text: "recovered" } as AssistantStreamEvent;
        yield {
          type: "done" as const,
          message: {
            id: "a2",
            role: "assistant" as const,
            content: "recovered",
            createdAt: "now",
          },
        } as AssistantStreamEvent;
      }
    }

    const result = await runStreamingAgentLoop(
      { userInput: "test" },
      { model: "test", streamFn, tools: [] },
    );

    expect(result.content).toBe("recovered");
    expect(result.iterations).toBe(2);
  });

  it("工具执行异常变成 error toolResult，不崩 loop", async () => {
    let callCount = 0;
    async function* streamFn() {
      callCount++;
      if (callCount === 1) {
        yield { type: "start" as const, messageId: "a1" } as AssistantStreamEvent;
        yield {
          type: "tool_call" as const,
          toolCall: { id: "tc1", name: "fail", input: {} },
        } as AssistantStreamEvent;
        yield {
          type: "done" as const,
          message: {
            id: "a1",
            role: "assistant" as const,
            content: "",
            createdAt: "now",
            toolCalls: [{ id: "tc1", name: "fail", input: {} }],
          },
        } as AssistantStreamEvent;
      } else {
        yield { type: "start" as const, messageId: "a2" } as AssistantStreamEvent;
        yield { type: "text_delta" as const, text: "recovered" } as AssistantStreamEvent;
        yield {
          type: "done" as const,
          message: {
            id: "a2",
            role: "assistant" as const,
            content: "recovered",
            createdAt: "now",
          },
        } as AssistantStreamEvent;
      }
    }

    const tool = defineTool({
      name: "fail",
      description: "Always fails",
      inputSchema: z.object({}),
      execute: () => {
        throw new Error("broken tool");
      },
    });

    const result = await runStreamingAgentLoop(
      { userInput: "test" },
      { model: "test", streamFn, tools: [tool] },
    );

    expect(result.content).toBe("recovered");
  });

  it("continueOnly 模式不添加新的 user 消息", async () => {
    async function* streamFn() {
      yield { type: "start" as const, messageId: "a1" } as AssistantStreamEvent;
      yield { type: "text_delta" as const, text: "continued" } as AssistantStreamEvent;
      yield {
        type: "done" as const,
        message: {
          id: "a1",
          role: "assistant" as const,
          content: "continued",
          createdAt: "now",
        },
      } as AssistantStreamEvent;
    }

    const result = await runStreamingAgentLoop(
      { continueOnly: true },
      { model: "test", streamFn },
    );

    expect(result.content).toBe("continued");
    // messages 应该只有 1 条（assistant 回复），没有 user 输入
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("assistant");
  });
});
