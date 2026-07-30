import { describe, expect, it, vi } from "vitest";

import { runChatPrompt } from "../src/cli/main.js";
import type { AgentSession } from "../src/core/agent-session.js";

describe("CLI stream routing", () => {
  it("routes streamed text to stdout and diagnostics to stderr", async () => {
    const listeners: Array<(event: any) => void> = [];
    const session = {
      subscribe(listener: (event: any) => void) {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        };
      },
      prompt: async () => {
        for (const listener of listeners) {
          listener({ type: "message_start", message: { role: "assistant", content: "" } });
          listener({
            type: "message_update",
            message: { role: "assistant", content: "Hello" },
            delta: { type: "text_delta", text: "Hello" },
          });
          listener({
            type: "tool_execution_start",
            toolCall: { id: "tool-1", name: "read-file", input: { path: "README.md" } },
          });
          listener({
            type: "tool_execution_end",
            toolCall: { id: "tool-1", name: "read-file", input: { path: "README.md" } },
            result: { output: "done", isError: false, truncated: false },
          });
          listener({ type: "error", error: new Error("boom") });
        }
        return {
          content: "Hello",
          messages: [],
          iterations: 1,
          terminationReason: "completed",
        };
      },
    } as unknown as AgentSession;

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    await expect(
      runChatPrompt({
        session,
        prompt: "Say hello",
        stdout,
        stderr,
      }),
    ).resolves.toEqual({});

    expect(stdout.write).toHaveBeenNthCalledWith(1, "Hello");
    expect(stdout.write).toHaveBeenNthCalledWith(2, "\n");
    expect(stderr.write).toHaveBeenNthCalledWith(1, "[tool] read-file\n");
    expect(stderr.write).toHaveBeenNthCalledWith(2, "[tool] read-file done\n");
    expect(stderr.write).toHaveBeenNthCalledWith(3, "Error: boom\n");
  });
});
