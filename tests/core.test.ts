import { describe, expect, it, vi } from "vitest";

import { Agent, runAgentLoop } from "../src/index.js";
import type { ModelInput, ModelProvider, Tool } from "../src/index.js";

describe("Agent core", () => {
  it("returns the model's final text through the exported Agent class", async () => {
    const model: ModelProvider = {
      generate: vi.fn().mockResolvedValue({ content: "hello", toolCalls: [] }),
    };

    const result = await new Agent({ model }).run("hi");

    expect(result.content).toBe("hello");
    expect(result.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(result.iterations).toBe(1);
  });

  it("executes requested tools in order and feeds their results back", async () => {
    const inputs: ModelInput[] = [];
    const executionOrder: string[] = [];
    const firstTool: Tool = {
      name: "first",
      description: "Returns the first result.",
      inputSchema: { type: "object" },
      async execute(input) {
        executionOrder.push("first");
        return { input, value: 1 };
      },
    };
    const secondTool: Tool = {
      name: "second",
      description: "Returns the second result.",
      inputSchema: { type: "object" },
      async execute() {
        executionOrder.push("second");
        return "two";
      },
    };
    const model: ModelProvider = {
      generate: vi.fn(async (input) => {
        inputs.push(input);
        if (inputs.length === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "call-1", name: "first", input: { key: "value" } },
              { id: "call-2", name: "second", input: {} },
            ],
          };
        }
        return { content: "finished", toolCalls: [] };
      }),
    };

    const result = await runAgentLoop("start", {
      model,
      tools: [firstTool, secondTool],
      systemPrompt: "Be concise.",
    });

    expect(executionOrder).toEqual(["first", "second"]);
    expect(inputs[0]).toMatchObject({
      messages: [{ role: "user", content: "start" }],
      systemPrompt: "Be concise.",
      tools: [
        { name: "first", description: firstTool.description },
        { name: "second", description: secondTool.description },
      ],
    });
    expect(inputs[1]?.messages.slice(-2)).toEqual([
      {
        role: "tool",
        content: '{"input":{"key":"value"},"value":1}',
        toolResult: {
          toolCallId: "call-1",
          name: "first",
          output: { input: { key: "value" }, value: 1 },
        },
      },
      {
        role: "tool",
        content: "two",
        toolResult: { toolCallId: "call-2", name: "second", output: "two" },
      },
    ]);
    expect(result.content).toBe("finished");
    expect(result.iterations).toBe(2);
  });

  it("returns unknown-tool and execution failures to the model", async () => {
    const failingTool: Tool = {
      name: "fail",
      description: "Always fails.",
      inputSchema: {},
      async execute() {
        throw new Error("tool broke");
      },
    };
    const generate = vi.fn()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          { id: "missing-1", name: "missing", input: {} },
          { id: "fail-1", name: "fail", input: {} },
        ],
      })
      .mockResolvedValueOnce({ content: "recovered", toolCalls: [] });

    const result = await runAgentLoop("start", {
      model: { generate },
      tools: [failingTool],
    });

    expect(result.messages.slice(2, 4)).toEqual([
      {
        role: "tool",
        content: "Unknown tool: missing",
        toolResult: {
          toolCallId: "missing-1",
          name: "missing",
          output: "Unknown tool: missing",
          isError: true,
        },
      },
      {
        role: "tool",
        content: "tool broke",
        toolResult: {
          toolCallId: "fail-1",
          name: "fail",
          output: "tool broke",
          isError: true,
        },
      },
    ]);
    expect(result.content).toBe("recovered");
  });

  it("rejects invalid limits and stops an endless tool loop", async () => {
    const model: ModelProvider = {
      generate: vi.fn().mockResolvedValue({
        content: "",
        toolCalls: [{ id: "call", name: "missing", input: {} }],
      }),
    };

    await expect(runAgentLoop("hi", { model, maxIterations: 0 })).rejects.toThrow(
      "maxIterations must be a positive integer",
    );
    await expect(runAgentLoop("hi", { model, maxIterations: 2 })).rejects.toThrow(
      "Agent loop reached the maximum of 2 iterations",
    );
    expect(model.generate).toHaveBeenCalledTimes(2);
  });
});
