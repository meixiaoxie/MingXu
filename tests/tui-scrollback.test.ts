import { describe, expect, it } from "vitest";

import { ProcessTerminal } from "@mingxu/tui";

describe("ProcessTerminal scrollback behavior", () => {
  it("does not clear the screen during ordinary incremental updates", () => {
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
    writes.length = 0;
    terminal.render(["second frame"]);

    expect(writes.join("")).not.toContain("\u001b[2J");
    expect(writes.join("")).toContain("second frame");
  });
});
