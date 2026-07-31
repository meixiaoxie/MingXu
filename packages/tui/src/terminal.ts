import { emitKeypressEvents } from "node:readline";

import { DifferentialRenderer, type DifferentialRenderStats, type FullReplayReason } from "./differential-renderer.js";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

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
  readonly #renderer = new DifferentialRenderer();
  #rawMode = false;
  #bracketedPaste = false;
  #pasteBuffer: string | undefined;
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
      if (sequence === BRACKETED_PASTE_START) {
        this.#pasteBuffer = "";
        return;
      }
      if (this.#pasteBuffer !== undefined) {
        if (sequence === BRACKETED_PASTE_END) {
          const pasted = this.#pasteBuffer;
          this.#pasteBuffer = undefined;
          this.#emitKeypress({ sequence: pasted, name: "paste" });
          return;
        }
        this.#pasteBuffer += sequence;
        return;
      }
      const input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean } = { sequence };
      if (key.name !== undefined) input.name = key.name;
      if (key.ctrl !== undefined) input.ctrl = key.ctrl;
      if (key.meta !== undefined) input.meta = key.meta;
      if (key.shift !== undefined) input.shift = key.shift;
      this.#emitKeypress(input);
    };
    this.#input.on("keypress", this.#keypressHandler);
    this.#resizeHandler = () => {
      for (const listener of this.#resizeListeners) {
        listener();
      }
    };
    this.#output.on("resize", this.#resizeHandler);
    this.#output.write("\x1b[?2004h");
    this.#bracketedPaste = true;
  }

  restore(): void {
    if (!this.#rawMode && !this.#bracketedPaste) {
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
    if (this.#rawMode) {
      this.#input.setRawMode?.(false);
    }
    this.#rawMode = false;
    this.#pasteBuffer = undefined;
    if (this.#bracketedPaste) {
      this.#output.write("\x1b[?2004l");
      this.#bracketedPaste = false;
    }
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

  get renderStats(): DifferentialRenderStats {
    return this.#renderer.stats;
  }

  render(
    lines: readonly string[],
    options: {
      readonly full?: boolean;
      readonly fullReason?: FullReplayReason;
      readonly commitPrefixLineCount?: number;
    } = {},
  ): { readonly requiresFullReplay: boolean; readonly replayReason?: FullReplayReason; readonly stats: DifferentialRenderStats } {
    if (!this.isTTY) {
      this.#output.write(`${lines.join("\n")}\n`);
      return { requiresFullReplay: false, stats: this.#renderer.stats };
    }

    const result = this.#renderer.render(lines, this.size, options);
    if (result.requiresFullReplay) {
      return {
        requiresFullReplay: true,
        ...(result.replayReason ? { replayReason: result.replayReason } : {}),
        stats: result.stats,
      };
    }
    if (result.output) this.#output.write(result.output);
    result.commit();
    return { requiresFullReplay: false, stats: result.stats };
  }

  moveCursorTo(row: number, column: number): void {
    if (!this.isTTY) {
      return;
    }
    this.#output.write(`\x1b[${Math.max(0, row + 1)};${Math.max(0, column + 1)}H`);
  }

  clearLine(): void {
    if (!this.isTTY) {
      return;
    }
    this.#output.write("\x1b[2K\r");
  }

  #emitKeypress(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void {
    for (const listener of this.#keyListeners) {
      listener(input);
    }
  }
}
