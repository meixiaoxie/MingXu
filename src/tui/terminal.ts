import { clearScreenDown, emitKeypressEvents } from "node:readline";

import { CURSOR_MARKER } from "./types.js";
import { visibleWidth } from "./strings.js";

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalKeyListener {
  (input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void;
}

export class ProcessTerminal {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;
  readonly #resizeListeners = new Set<() => void>();
  readonly #keyListeners = new Set<TerminalKeyListener>();
  #rawMode = false;
  #keypressHandler: ((sequence: string, key: import("node:readline").Key) => void) | undefined;
  #resizeHandler: (() => void) | undefined;

  constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream) {
    this.#input = input;
    this.#output = output;
  }

  get isTTY(): boolean {
    return this.#input.isTTY && this.#output.isTTY;
  }

  get size(): TerminalSize {
    return {
      columns: this.#output.columns || 80,
      rows: this.#output.rows || 24,
    };
  }

  onResize(listener: () => void): () => void {
    this.#resizeListeners.add(listener);
    return () => this.#resizeListeners.delete(listener);
  }

  onKeypress(listener: TerminalKeyListener): () => void {
    this.#keyListeners.add(listener);
    return () => this.#keyListeners.delete(listener);
  }

  enterRawMode(): void {
    if (!this.isTTY || this.#rawMode) {
      return;
    }
    emitKeypressEvents(this.#input);
    this.#input.resume();
    this.#input.setRawMode?.(true);
    this.#rawMode = true;
    this.#keypressHandler = (sequence, key) => {
      const input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean } = { sequence };
      if (key.name !== undefined) input.name = key.name;
      if (key.ctrl !== undefined) input.ctrl = key.ctrl;
      if (key.meta !== undefined) input.meta = key.meta;
      if (key.shift !== undefined) input.shift = key.shift;
      for (const listener of this.#keyListeners) {
        listener(input);
      }
    };
    this.#input.on("keypress", this.#keypressHandler);
    this.#resizeHandler = () => {
      for (const listener of this.#resizeListeners) {
        listener();
      }
    };
    this.#output.on("resize", this.#resizeHandler);
  }

  restore(): void {
    if (!this.#rawMode) {
      return;
    }
    if (this.#keypressHandler) {
      this.#input.off("keypress", this.#keypressHandler);
      this.#keypressHandler = undefined;
    }
    if (this.#resizeHandler) {
      this.#output.off("resize", this.#resizeHandler);
      this.#resizeHandler = undefined;
    }
    this.#input.setRawMode?.(false);
    this.#rawMode = false;
    this.showCursor();
  }

  write(value: string): void {
    this.#output.write(value);
  }

  hideCursor(): void {
    if (this.isTTY) {
      this.#output.write("\x1b[?25l");
    }
  }

  showCursor(): void {
    if (this.isTTY) {
      this.#output.write("\x1b[?25h");
    }
  }

  clearActiveRegion(): void {
    if (!this.isTTY) {
      return;
    }
    this.#output.write("\r\x1b[0J");
  }

  render(lines: readonly string[]): void {
    if (!this.isTTY) {
      this.#output.write(`${lines.join("\n")}\n`);
      return;
    }

    const rendered = [...lines];
    const cursorPosition = extractCursorPosition(rendered);
    const text = rendered.join("\r\n");
    this.#output.write("\x1b[2J\x1b[H");
    this.hideCursor();
    this.#output.write(text);
    if (cursorPosition) {
      this.moveCursorTo(cursorPosition.row, cursorPosition.column);
      this.showCursor();
    }
  }

  moveCursorTo(row: number, column: number): void {
    if (!this.isTTY) {
      return;
    }
    this.#output.write(`\x1b[${Math.max(0, row + 1)};${Math.max(0, column + 1)}H`);
  }
}

function extractCursorPosition(lines: string[]): { row: number; column: number } | undefined {
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    if (line === undefined) {
      continue;
    }
    const markerIndex = line.indexOf(CURSOR_MARKER);
    if (markerIndex === -1) {
      continue;
    }
    lines[row] = line.replace(CURSOR_MARKER, "");
    const column = visibleWidth(line.slice(0, markerIndex));
    return { row, column };
  }
  return undefined;
}
