import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";
import type { ModelProvider, AgentEvent } from "../src/index.js";

describe("Agent", () => {
  it("subscribe 能收到事件", async () => {
    const events: string[] = [];
    const model: ModelProvider = {
      async generate() {
        return { content: "ok", toolCalls: [] };
      },
    };
    const agent = new Agent({ model });

    agent.subscribe((e: AgentEvent) => {
      events.push(e.type);
    });
    await agent.prompt("hi");

    // 必须包含 agent_start 和 agent_end
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
    // 不报错即通过——abort 在没有执行时可以安全调用
  });

  it("steer 和 followUp 不报错", () => {
    const model: ModelProvider = {
      async generate() {
        return { content: "x", toolCalls: [] };
      },
    };
    const agent = new Agent({ model });
    agent.steer("纠正一下方向");
    agent.followUp("继续做下一件事");
    // steer 和 followUp 只是把消息放入队列，总是安全的
  });

  it("retry 用上次输入重跑", async () => {
    let calls = 0;
    const model: ModelProvider = {
      async generate() {
        calls++;
        // 第一次调用失败，第二次成功
        if (calls === 1) throw new Error("fail");
        return { content: "recovered", toolCalls: [] };
      },
    };
    const agent = new Agent({ model });

    // 第一次失败
    await expect(agent.prompt("test")).rejects.toThrow("fail");
    // retry 应该用相同的输入重跑，并且这次成功
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

    // 执行前的状态
    const beforeState = agent.state;
    expect(beforeState.systemPrompt).toBe("Be helpful");
    expect(beforeState.messages).toHaveLength(0);

    await agent.prompt("hi");

    // 执行后的状态——消息列表更新了
    const afterState = agent.state;
    expect(afterState.messages.length).toBeGreaterThan(0);
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

  it("continue() 不追加新用户消息", async () => {
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

    // 先开启对话
    await agent.prompt("hello");
    // 再继续——不追加新 user 消息
    const result = await agent.continue();

    expect(result.content).toBe("continued");
  });
});
