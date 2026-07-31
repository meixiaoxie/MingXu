import { describe, expect, it } from "vitest";

import { ProcessTerminal } from "@mingxu/tui";

describe("ProcessTerminal scrollback behavior", () => {
  function createTerminal(options: { readonly columns?: number; readonly rows?: number } = {}) {
    const writes: string[] = [];
    const output = {
      isTTY: true,
      columns: options.columns ?? 80,
      rows: options.rows ?? 24,
      write(chunk: string) {
        writes.push(chunk);
        return true;
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
    return { terminal, writes, output };
  }

  it("promotes committed prefixes and redraws only changed active lines", () => {
    const { terminal, writes } = createTerminal();

    terminal.render(["completed transcript", "active line", "footer"], {
      full: true,
      commitPrefixLineCount: 1,
    });
    writes.length = 0;
    const result = terminal.render(["active line changed", "footer"]);

    const output = writes.join("");
    expect(output).not.toContain("\u001b[2J");
    expect(output).not.toContain("completed transcript");
    expect(output).toContain("active line changed");
    expect(output).not.toContain("footer");
    expect(result.stats).toMatchObject({
      activeLineCount: 2,
      committedLineCount: 1,
      renderedLineCount: 1,
      fullRedrawCount: 1,
    });
  });

  it("requests a full replay when resize invalidates the active viewport", () => {
    const { terminal, writes, output } = createTerminal({ columns: 80, rows: 3 });

    terminal.render(["history", "active", "footer"], { full: true, commitPrefixLineCount: 1 });
    writes.length = 0;
    Object.assign(output, { columns: 60 });
    const result = terminal.render(["active", "footer"]);

    expect(result).toMatchObject({ requiresFullReplay: true, replayReason: "width-change" });
    expect(writes).toHaveLength(0);
    terminal.render(["history", "active", "footer"], {
      full: true,
      commitPrefixLineCount: 1,
    });
    expect(writes.join("")).toContain("\u001b[2J");
  });

  it("does not clear the screen during ordinary incremental updates", () => {
    const { terminal, writes } = createTerminal();

    terminal.render(["first frame"]);
    writes.length = 0;
    terminal.render(["second frame"]);

    expect(writes.join("")).not.toContain("\u001b[2J");
    expect(writes.join("")).toContain("second frame");
  });
});
