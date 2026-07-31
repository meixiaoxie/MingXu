import { describe, expect, it } from "vitest";

import {
  COMPOSITION_END,
  COMPOSITION_START,
  CURSOR_MARKER,
  Editor,
  SELECTION_END,
  SELECTION_START,
  visibleWidth,
} from "@mingxu/tui";

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

  it("undoes and redoes grapheme and multiline paste edits", () => {
    const editor = new Editor({ prompt: "> " });

    editor.handleInput({ sequence: "start", name: "paste" });
    editor.handleInput({ sequence: "\n中文🙂", name: "paste" });
    expect(editor.value).toBe("start\n中文🙂");

    editor.handleInput({ sequence: "", name: "z", ctrl: true });
    expect(editor.value).toBe("start");
    editor.handleInput({ sequence: "", name: "y", ctrl: true });
    expect(editor.value).toBe("start\n中文🙂");
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

  it("tracks anchor/focus selections across graphemes and replaces them atomically", () => {
    const editor = new Editor({ prompt: "> " });
    const original = "é🙂中\n日本語👩‍💻";
    editor.handleInput({ sequence: original, name: "paste" });
    editor.handleInput({ sequence: "", name: "a", ctrl: true });
    editor.handleInput({ sequence: "", name: "right", shift: true });
    editor.handleInput({ sequence: "", name: "right", shift: true });
    editor.handleInput({ sequence: "", name: "right", shift: true });

    expect(editor.selection).toEqual({ anchor: 0, focus: 3, start: 0, end: 3 });
    const rendered = editor.render(8).join("\n");
    expect(rendered).toContain(`${SELECTION_START}é${SELECTION_END}`);
    expect(rendered).toContain(`${SELECTION_START}🙂${SELECTION_END}`);
    expect(rendered).toContain(`${SELECTION_START}中${SELECTION_END}`);

    editor.handleInput({ sequence: "한", name: "paste" });
    expect(editor.value).toBe("한\n日本語👩‍💻");
    expect(editor.selection).toBeUndefined();
    editor.handleInput({ sequence: "", name: "z", ctrl: true });
    expect(editor.value).toBe(original);
    expect(editor.selection).toEqual({ anchor: 0, focus: 3, start: 0, end: 3 });
    editor.handleInput({ sequence: "", name: "y", ctrl: true });
    expect(editor.value).toBe("한\n日本語👩‍💻");
  });

  it("deletes selected multiline graphemes without splitting combining, CJK, or ZWJ text", () => {
    const editor = new Editor({ prompt: "> " });
    editor.handleInput({ sequence: "a\né中文👩‍💻b", name: "paste" });
    editor.handleInput({ sequence: "", name: "a", ctrl: true });
    for (let index = 0; index < 6; index += 1) {
      editor.handleInput({ sequence: "", name: "right", shift: true });
    }

    expect(editor.selection).toEqual({ anchor: 0, focus: 6, start: 0, end: 6 });
    editor.handleInput({ sequence: "", name: "delete" });
    expect(editor.value).toBe("b");
    editor.handleInput({ sequence: "", name: "z", ctrl: true });
    expect(editor.value).toBe("a\né中文👩‍💻b");
  });

  it("keeps IME preedit text out of the draft, completion, and submit path", () => {
    const editor = new Editor({
      prompt: "> ",
      completionProvider: (value) => value.startsWith("/") ? [{ id: "help", label: "/help" }] : [],
    });
    editor.handleInput({ sequence: "/", name: "/" });
    expect(editor.render(40).join("\n")).toContain("/help");

    editor.handleComposition("start");
    editor.handleComposition("update", "中文");
    expect(editor.value).toBe("/");
    expect(editor.composition).toEqual({ text: "中文", start: 1, end: 1 });
    const preedit = editor.render(40).join("\n");
    expect(preedit).toContain(`${COMPOSITION_START}中${COMPOSITION_END}`);
    expect(preedit).toContain(`${COMPOSITION_START}文${COMPOSITION_END}`);
    expect(preedit).not.toContain("/help");
    expect(editor.handleInput({ sequence: "", name: "enter" })).toEqual({ type: "none" });
    expect(editor.value).toBe("/");

    editor.handleComposition("cancel");
    expect(editor.composition).toBeUndefined();
    expect(editor.value).toBe("/");
    expect(editor.render(40).join("\n")).toContain("/help");
  });

  it("commits composition as one selectable undoable edit", () => {
    const editor = new Editor({ prompt: "> " });
    editor.handleInput({ sequence: "中文", name: "paste" });
    editor.handleInput({ sequence: "", name: "a", ctrl: true });
    editor.handleInput({ sequence: "", name: "end", shift: true });

    editor.handleInput({ sequence: "", composition: "start" });
    editor.handleInput({ sequence: "日本", composition: "update" });
    editor.handleInput({ sequence: "日本", composition: "commit" });
    expect(editor.value).toBe("日本");
    expect(editor.composition).toBeUndefined();
    editor.handleInput({ sequence: "", name: "z", ctrl: true });
    expect(editor.value).toBe("中文");
    expect(editor.selection).toEqual({ anchor: 0, focus: 2, start: 0, end: 2 });
    editor.handleInput({ sequence: "", name: "y", ctrl: true });
    expect(editor.value).toBe("日本");
  });

  it("keeps logical selections stable through width changes and Ctrl+J multiline input", () => {
    const editor = new Editor({ prompt: "> ", placeholder: "Ctrl+J inserts a newline" });
    expect(editor.render(80).join("\n")).toContain("Ctrl+J inserts a newline");
    editor.handleInput({ sequence: "中文🙂abcdef", name: "paste" });
    editor.handleInput({ sequence: "", name: "a", ctrl: true });
    for (let index = 0; index < 3; index += 1) {
      editor.handleInput({ sequence: "", name: "right", shift: true });
    }
    const expected = editor.selection;

    for (const width of [60, 80, 120]) {
      const lines = editor.render(width);
      expect(editor.selection).toEqual(expected);
      expect(lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }

    editor.handleInput({ sequence: "", name: "j", ctrl: true });
    expect(editor.value).toBe("\nabcdef");
  });

  it.each([
    ["Windows Terminal", "中文输入"],
    ["PowerShell", "日本語かな"],
    ["cmd", "한글 조합"],
    ["Unix terminal", "é👩‍💻"],
  ])("accepts the committed %s input sample at every supported width", (_terminal, sample) => {
    const editor = new Editor({ prompt: "> " });
    editor.handleInput({ sequence: sample, name: "paste" });

    expect(editor.value).toBe(sample);
    for (const width of [60, 80, 120]) {
      const lines = editor.render(width);
      expect(lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });
});
