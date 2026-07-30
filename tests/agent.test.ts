import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";
import type { AgentEvent, ModelProvider } from "../src/index.js";

describe("Agent", () => {
  it("subscribe 能收到事件", async () => {
    const events: string[] = [];
    const model: ModelProvider = {
      async generate() {
        return { content: "ok", toolCalls: [] };
      },
    };
    const agent = new Agent({ model });

    agent.subscribe((event: AgentEvent) => {
      events.push(event.type);
    });
    await agent.prompt("hi");

    expect(events).toContain("agent_start");
    expect(events).toContain("agent_end");
  });

  it("abort 可以被安全调用", () => {
    const model: ModelProvider = {
      async generate() {
        return { content: "x", toolCalls: [] };
      },
    };
    const agent = new Agent({ model });
    agent.abort();
  });

  it("steer 和 followUp 不会报错", () => {
    const model: ModelProvider = {
      async generate() {
        return { content: "x", toolCalls: [] };
      },
    };
    const agent = new Agent({ model });
    agent.steer("纠正一下方向");
    agent.followUp("继续做下一件事");
  });

  it("retry 使用上一次输入重跑", async () => {
    let calls = 0;
    const model: ModelProvider = {
      async generate() {
        calls++;
        if (calls === 1) throw new Error("fail");
        return { content: "recovered", toolCalls: [] };
      },
    };
    const agent = new Agent({ model });

    await expect(agent.prompt("test")).rejects.toThrow("fail");
    const result = await agent.retry();
    expect(result.content).toBe("recovered");
  });

  it("state 返回当前状态的快照", async () => {
    const model: ModelProvider = {
      async generate() {
        return { content: "done", toolCalls: [] };
      },
    };
    const agent = new Agent({ model, systemPrompt: "Be helpful" });

    const beforeState = agent.state;
    expect(beforeState.systemPrompt).toBe("Be helpful");
    expect(beforeState.messages).toHaveLength(0);

    await agent.prompt("hi");

    const afterState = agent.state;
    expect(afterState.messages.length).toBeGreaterThan(0);
  });

  it("state 在工具 schema 含有函数时也能安全快照", () => {
    const model: ModelProvider = {
      async generate() {
        return { content: "done", toolCalls: [] };
      },
    };
    const agent = new Agent({
      model,
      tools: [
        {
          name: "unsafe",
          description: "contains function schema",
          inputSchema: {
            parse() {
              return true;
            },
          },
          async execute() {
            return "ok";
          },
        },
      ],
    });

    const state = agent.state;
    expect(state.tools).toHaveLength(1);
    expect(() => JSON.stringify(state)).not.toThrow();
  });

  it("run() 兼容旧 API", async () => {
    const model: ModelProvider = {
      async generate() {
        return { content: "legacy", toolCalls: [] };
      },
    };
    const agent = new Agent({ model });
    const result = await agent.run("hi");
    expect(result.content).toBe("legacy");
  });

  it("continue() 不追加新的 user 消息", async () => {
    let callCount = 0;
    const model: ModelProvider = {
      async generate() {
        callCount++;
        return {
          content: callCount === 1 ? "first" : "continued",
          toolCalls: [],
        };
      },
    };
    const agent = new Agent({ model });

    await agent.prompt("hello");
    const result = await agent.continue();

    expect(result.content).toBe("continued");
  });
  it("decorates lifecycle events with stable metadata", async () => {
    const events: AgentEvent[] = [];
    const model: ModelProvider = {
      async generate() {
        return { content: "done", toolCalls: [] };
      },
    };
    const agent = new Agent({ model });

    agent.subscribe((event: AgentEvent) => {
      events.push(event);
    });

    await agent.prompt("hi");

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.eventId && event.source === "core" && typeof event.sequence === "number")).toBe(true);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(new Set(events.map((event) => event.runId)).size).toBe(1);
    expect(events.some((event) => event.type === "message_start" && event.messageId)).toBe(true);
  });
});
