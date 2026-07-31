import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { Box, Editor, KeyValue, SelectList, Text, ProcessTerminal } from "@mingxu/tui";

describe("tui components", () => {
  it("renders slash command suggestions and accepts a completion", () => {
    const editor = new Editor({
      prompt: "> ",
      completionProvider: (value) => [
        { id: "help", label: "/help", description: "Show available chat commands." },
        { id: "history", label: "/history", description: "Show recent conversation state." },
      ].filter((item) => item.label.startsWith(value)),
    });

    editor.handleInput({ sequence: "/", name: "/" });
    editor.handleInput({ sequence: "h", name: "h" });
    const rendered = editor.render(80).join("\n");
    expect(rendered).toContain("/help");

    editor.handleInput({ sequence: "", name: "tab" });
    const result = editor.handleInput({ sequence: "", name: "enter" });
    expect(result).toEqual({ type: "submit", value: "/help" });
  });

  it("renders boxed content and key/value summaries", () => {
    const box = new Box(new KeyValue([
      ["model", "deepseek-v4-flash"],
      ["session", "session-1"],
    ]), "Status");
    const text = new Text({ text: "Hello MingXu" });
    const list = new SelectList([
      { id: "one", label: "One" },
      { id: "two", label: "Two" },
    ]);
    list.move(1);

    expect(box.render(40).join("\n")).toContain("Status");
    expect(text.render(20)).toEqual(["Hello MingXu"]);
    expect(list.render(20).join("\n")).toContain("> Two");
  });

  it("ProcessTerminal 会在 TTY 重绘时回到屏幕顶部", () => {
    const writes: string[] = [];
    const output = {
      isTTY: true,
      columns: 80,
      rows: 24,
      write(chunk: string) {
        writes.push(chunk);
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;
    const input = {
      isTTY: true,
      resume() {},
      setRawMode() {},
      on() {},
      off() {},
    } as unknown as NodeJS.ReadStream;
    const terminal = new ProcessTerminal(input, output);

    terminal.render(["first frame"]);
    terminal.render(["second frame"]);

    expect(writes.join("")).toContain("\u001b[H");
    expect(writes.join("")).toContain("second frame");
  });

  it("groups bracketed paste and restores the terminal mode symmetrically", () => {
    const writes: string[] = [];
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      resume() {},
      setRawMode: vi.fn(),
    }) as unknown as NodeJS.ReadStream;
    const output = Object.assign(new EventEmitter(), {
      isTTY: true,
      columns: 80,
      rows: 24,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    }) as unknown as NodeJS.WriteStream;
    const terminal = new ProcessTerminal(input, output);
    const keys: Array<{ sequence: string; name?: string }> = [];
    terminal.onKeypress((key) => keys.push(key));

    terminal.enterRawMode();
    input.emit("keypress", "\x1b[200~", { sequence: "\x1b[200~" });
    input.emit("keypress", "line one\nline two", { sequence: "line one\nline two" });
    input.emit("keypress", "\x1b[201~", { sequence: "\x1b[201~" });
    terminal.restore();

    expect(keys).toEqual([{ sequence: "line one\nline two", name: "paste" }]);
    expect(writes.join("")).toContain("\x1b[?2004h");
    expect(writes.join("")).toContain("\x1b[?2004l");
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenNthCalledWith(2, false);
  });
});
