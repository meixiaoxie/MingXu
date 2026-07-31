import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { ChatInputController } from "../src/cli/chat-input.js";

function createInputStream() {
  return Object.assign(new EventEmitter(), {
    isTTY: true,
    resume() {},
    setRawMode() {},
  }) as unknown as EventEmitter & NodeJS.ReadStream;
}

function createOutputStream() {
  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 20,
    rows: 8,
    write(chunk: string) {
      writes.push(chunk);
    },
  } as NodeJS.WriteStream;
  return { output, writes };
}

describe("ChatInputController", () => {
  it("accepts multiline raw input and returns the composed line", async () => {
    const input = createInputStream();
    const { output, writes } = createOutputStream();
    const controller = new ChatInputController({
      input,
      output,
      enableRawMode: true,
    });

    const linePromise = controller.readLine("> ");
    input.emit("keypress", "h", { name: "h" });
    input.emit("keypress", "e", { name: "e" });
    input.emit("keypress", "l", { name: "l" });
    input.emit("keypress", "l", { name: "l" });
    input.emit("keypress", "o", { name: "o" });
    input.emit("keypress", "", { name: "j", ctrl: true });
    input.emit("keypress", "w", { name: "w" });
    input.emit("keypress", "o", { name: "o" });
    input.emit("keypress", "r", { name: "r" });
    input.emit("keypress", "l", { name: "l" });
    input.emit("keypress", "d", { name: "d" });
    input.emit("keypress", "", { name: "enter" });

    await expect(linePromise).resolves.toBe("hello\nworld");
    expect(writes.join("")).toContain("hello");
    expect(writes.join("")).toContain("world");

    controller.close();
  });

  it("does not submit IME preedit text before the composition commit", async () => {
    const input = createInputStream();
    const { output, writes } = createOutputStream();
    const controller = new ChatInputController({
      input,
      output,
      enableRawMode: true,
    });

    const linePromise = controller.readLine("> ");
    input.emit("keypress", "", { composition: "start" });
    input.emit("keypress", "日本", { composition: "update" });
    input.emit("keypress", "", { name: "enter" });
    await Promise.resolve();
    expect(writes.join("")).toContain("\x1b[4m日\x1b[24m");

    input.emit("keypress", "日本", { composition: "commit" });
    input.emit("keypress", "", { name: "enter" });
    await expect(linePromise).resolves.toBe("日本");
    controller.close();
  });
});
