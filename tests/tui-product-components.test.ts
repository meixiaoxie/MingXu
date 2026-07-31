import { describe, expect, it } from "vitest";

import {
  CommandBlock,
  Diff,
  KeyValue,
  Markdown,
  Progress,
  Table,
  Tree,
  sanitizeTerminalText,
  visibleWidth,
} from "@mingxu/tui";

describe("TUI product components", () => {
  it("renders GFM markdown structures safely within a compact viewport", () => {
    const markdown = new Markdown([
      "# Heading",
      "",
      "> quoted `code`",
      "",
      "- first",
      "- [link](https://example.com)",
      "",
      "```ts",
      "console.log('hello')",
      "```",
      "",
      "| name | state |",
      "| --- | --- |",
      "| worker | running |",
      `long ${"x".repeat(180)}\u001b]52;c;secret\u0007 safe`,
    ].join("\n"));

    const lines = markdown.render(60);
    const rendered = lines.join("\n");
    expect(rendered).toContain("# Heading");
    expect(rendered).toContain("> quoted `code`");
    expect(rendered).toContain("link (https://example.com)");
    expect(rendered).toContain("```ts");
    expect(rendered).toContain("worker");
    expect(rendered).not.toContain("secret");
    expect(rendered).not.toContain("\u001b");
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  it("renders unified diff states, line numbers, folding, truncation, and collapse without color", () => {
    const diff = new Diff([
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -10,10 +10,10 @@ function demo()",
      ...Array.from({ length: 8 }, (_, index) => ` context ${index}`),
      "-old value",
      `+new ${"value".repeat(30)}\u001b[31mspoof`,
    ], { maxContextLines: 4 });

    const lines = diff.render(60);
    const rendered = lines.join("\n");
    expect(rendered).toContain("diff --git a/a.ts b/a.ts");
    expect(rendered).toContain("... 4 unchanged lines ...");
    expect(rendered).toMatch(/18\s+\|\s+- old value/u);
    expect(rendered).toMatch(/18\s+\|\s+\+ new/u);
    expect(rendered).not.toContain("\u001b");
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);

    diff.toggleCollapsed();
    expect(diff.render(60).join("\n")).toContain("diff collapsed");
    expect(diff.render(60).join("\n")).not.toContain("old value");
  });

  it("tracks live command streams and terminal outcomes with bounded output", () => {
    const block = new CommandBlock({ command: "pnpm test", maxLines: 3 });
    block.append("stdout", "one\ntwo");
    block.append("stderr", "\u001b[31mfailed\u001b[0m\nthree\nfour");
    block.update({ status: "cancelled", signal: "SIGINT", durationMs: 1250, cancellationSummary: "user cancelled 2 workers" });

    const rendered = block.render(44).join("\n");
    expect(rendered).toContain("status: cancelled");
    expect(rendered).toContain("signal: SIGINT");
    expect(rendered).toContain("duration: 1.3s");
    expect(rendered).toContain("earlier output lines omitted");
    expect(rendered).toContain("err | four");
    expect(rendered).toContain("cancel: user cancelled 2 workers");
    expect(rendered).not.toContain("\u001b");

    block.toggleCollapsed();
    expect(block.render(44).join("\n")).toContain("output collapsed");
  });

  it("isolates concurrent command output during out-of-order updates", () => {
    const first = new CommandBlock({ command: "first" });
    const second = new CommandBlock({ command: "second" });
    const third = new CommandBlock({ command: "third" });
    const fourth = new CommandBlock({ command: "fourth" });
    first.append("stdout", "first-output");
    second.append("stderr", "second-error");
    third.append("stdout", "third-output");
    fourth.append("stderr", "fourth-error");

    third.update({ status: "failed", exitCode: 2, durationMs: 30 });
    first.update({ status: "completed", exitCode: 0, durationMs: 40 });
    fourth.update({ status: "cancelled", signal: "SIGTERM", durationMs: 20 });

    expect(first.render(40).join("\n")).toContain("first-output");
    expect(first.render(40).join("\n")).not.toContain("second-error");
    expect(second.render(40).join("\n")).toContain("status: running");
    expect(third.render(40).join("\n")).toContain("exit: 2");
    expect(fourth.render(40).join("\n")).toContain("signal: SIGTERM");
  });

  it("degrades structured components on narrow terminals and sanitizes every cell", () => {
    const table = new Table([
      ["name", "state"],
      ["worker\u001b]8;;https://evil.invalid\u0007link\u001b]8;;\u0007", "running"],
    ], { header: true });
    const tree = new Tree([{ id: "root", label: "root\u001bPpayload\u001b\\", children: [{ id: "child", label: "child" }] }]);
    const keyValue = new KeyValue([["key\u0000", "value-without-spaces-xxxxxxxxxxxxxxxx"]]);
    const progress = new Progress("download\u001b[2J", 5, 10);
    const lines = [
      ...table.render(18),
      ...tree.render(18),
      ...keyValue.render(18),
      ...progress.render(18),
    ];

    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.every((line) => visibleWidth(line) <= 18)).toBe(true);
    expect(progress.render(12)).toEqual(["download 50%"]);
  });

  it("replaces invalid Unicode and omits binary-like output", () => {
    expect(sanitizeTerminalText(`left${String.fromCharCode(0xd800)}right`)).toBe("left\uFFFDright");
    expect(sanitizeTerminalText("\u0000\u0001\u0000\u0002payload")).toBe("[binary output omitted]");
    expect(sanitizeTerminalText("safe\u001b]52;c;secret")).toBe("safe");
  });
});
