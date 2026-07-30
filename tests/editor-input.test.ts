import { describe, expect, it } from "vitest";

import { CURSOR_MARKER, Editor } from "@mingxu/tui";

describe("Editor input behavior", () => {
  it("keeps grapheme clusters intact when deleting and moving the cursor", () => {
    const editor = new Editor({ prompt: "> " });

    editor.handleInput({ sequence: "é", name: "e" });
    editor.handleInput({ sequence: "", name: "backspace" });
    expect(editor.value).toBe("");

    editor.handleInput({ sequence: "🙂a", name: "a" });
    editor.handleInput({ sequence: "", name: "left" });
    editor.handleInput({ sequence: "", name: "backspace" });

    expect(editor.value).toBe("a");
  });

  it("moves through visual lines before falling back to history", () => {
    const editor = new Editor({
      prompt: "> ",
      history: ["past command"],
    });

    editor.handleInput({ sequence: "first", name: "f" });
    editor.handleInput({ sequence: "", name: "enter", shift: true });
    editor.handleInput({ sequence: "second", name: "s" });

    const firstRender = editor.render(12);
    expect(firstRender.findIndex((line) => line.includes(CURSOR_MARKER))).toBe(1);

    editor.handleInput({ sequence: "", name: "up" });
    const secondRender = editor.render(12);
    expect(secondRender.findIndex((line) => line.includes(CURSOR_MARKER))).toBe(0);
    expect(editor.value).toBe("first\nsecond");

    editor.handleInput({ sequence: "", name: "up" });
    expect(editor.value).toBe("past command");

    editor.handleInput({ sequence: "", name: "down" });
    expect(editor.value).toBe("first\nsecond");
  });

  it("inserts newlines with Ctrl+J and submits multiline input", () => {
    const editor = new Editor({ prompt: "> " });

    editor.handleInput({ sequence: "hello", name: "h" });
    editor.handleInput({ sequence: "", name: "j", ctrl: true });
    editor.handleInput({ sequence: "world", name: "w" });

    expect(editor.value).toBe("hello\nworld");
    expect(editor.handleInput({ sequence: "", name: "enter" })).toEqual({
      type: "submit",
      value: "hello\nworld",
    });
  });

  it("keeps slash completion scoped to the beginning of the input and closes cleanly", () => {
    const editor = new Editor({
      prompt: "> ",
      completionProvider: (value) => [
        { id: "help", label: "/help", description: "Show available chat commands." },
        { id: "history", label: "/history", description: "Show recent conversation state." },
      ].filter((item) => item.label.startsWith(value)),
    });

    editor.handleInput({ sequence: "hello /he", name: "h" });
    expect(editor.render(80).join("\n")).not.toContain("/help");

    editor.clear();
    editor.handleInput({ sequence: "/", name: "/" });
    editor.handleInput({ sequence: "h", name: "h" });
    expect(editor.render(80).join("\n")).toContain("/help");

    editor.handleInput({ sequence: "", name: "escape" });
    expect(editor.value).toBe("/h");
    expect(editor.render(80).join("\n")).not.toContain("/help");
  });
});
