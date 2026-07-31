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

  it("keeps stdout and stderr stable when streamed events arrive out of order", async () => {
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
          listener({
            type: "message_update",
            eventId: "event-update-1",
            sequence: 2,
            source: "core",
            message: { id: "assistant-1", role: "assistant", content: "Hello" },
            delta: { type: "text_delta", text: "Hello" },
          });
          listener({
            type: "message_start",
            eventId: "event-start-1",
            sequence: 1,
            source: "core",
            message: { id: "assistant-1", role: "assistant", content: "" },
          });
          listener({
            type: "message_update",
            eventId: "event-update-2",
            sequence: 3,
            source: "core",
            message: { id: "assistant-1", role: "assistant", content: "Hello world" },
            delta: { type: "text_delta", text: " world" },
          });
          listener({
            type: "message_update",
            eventId: "event-update-2",
            sequence: 3,
            source: "core",
            message: { id: "assistant-1", role: "assistant", content: "Hello world" },
            delta: { type: "text_delta", text: " world" },
          });
          listener({
            type: "tool_execution_start",
            eventId: "event-tool-start",
            sequence: 4,
            source: "core",
            toolCall: { id: "tool-1", name: "read-file", input: { path: "README.md" } },
          });
          listener({
            type: "tool_execution_end",
            eventId: "event-tool-end",
            sequence: 5,
            source: "core",
            toolCall: { id: "tool-1", name: "read-file", input: { path: "README.md" } },
            result: { toolCallId: "tool-1", name: "read-file", output: "done", isError: false, truncated: false },
          });
        }
        return {
          content: "Hello world",
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
    expect(stdout.write).toHaveBeenNthCalledWith(2, " world");
    expect(stdout.write).toHaveBeenNthCalledWith(3, "\n");
    expect(stderr.write).toHaveBeenNthCalledWith(1, "[tool] read-file\n");
    expect(stderr.write).toHaveBeenNthCalledWith(2, "[tool] read-file done\n");
  });

  it("removes the SIGINT listener after aborting an in-flight prompt", async () => {
    const beforeListeners = process.listenerCount("SIGINT");
    let resolvePrompt: ((value: {
      content: string;
      messages: [];
      iterations: number;
      terminationReason: string;
    }) => void) | undefined;

    const promptPromise = new Promise<{
      content: string;
      messages: [];
      iterations: number;
      terminationReason: string;
    }>((resolve) => {
      resolvePrompt = resolve;
    });

    const session = {
      subscribe() {
        return () => undefined;
      },
      prompt: async () => promptPromise,
      abort: () => {
        resolvePrompt?.({
          content: "",
          messages: [],
          iterations: 1,
          terminationReason: "aborted",
        });
      },
    } as unknown as AgentSession;

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const run = runChatPrompt({
      session,
      prompt: "Keep running",
      stdout,
      stderr,
    });

    process.emit("SIGINT");

    await expect(run).resolves.toEqual({});
    expect(process.listenerCount("SIGINT")).toBe(beforeListeners);
    expect(stderr.write).not.toHaveBeenCalledWith(expect.stringContaining("Error:"));
  });
});
