import { describe, expect, it } from "vitest";

import { Box, Editor, KeyValue, SelectList, Text } from "../src/tui/index.js";

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
});

