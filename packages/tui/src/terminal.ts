import { DifferentialRenderer, type DifferentialRenderStats, type FullReplayReason } from "./differential-renderer.js";
import {
  TerminalLifecycle,
  type TerminalCapabilities,
  type TerminalLifecycleOptions,
  type TerminalProcessHandlers,
} from "./terminal-lifecycle.js";
import type { KeyInput } from "./types.js";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalKeyListener {
  (input: KeyInput): void;
}

export class ProcessTerminal {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;
  readonly #resizeListeners = new Set<() => void>();
  readonly #keyListeners = new Set<TerminalKeyListener>();
  readonly #errorListeners = new Set<(error: unknown) => void>();
  readonly #renderer = new DifferentialRenderer();
  readonly #lifecycle: TerminalLifecycle;
  #pasteBuffer: string | undefined;

  constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream, options: TerminalLifecycleOptions = {}) {
    this.#input = input;
    this.#output = output;
    this.#lifecycle = new TerminalLifecycle(input, output, options);
  }

  get isTTY(): boolean {
    return Boolean(this.#input.isTTY && this.#output.isTTY);
  }

  get isInteractive(): boolean {
    return this.#lifecycle.capabilities.interactive;
  }

  get capabilities(): TerminalCapabilities {
    return this.#lifecycle.capabilities;
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

  onError(listener: (error: unknown) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  enterRawMode(): boolean {
    return this.#lifecycle.enter({
      onKeypress: (sequence, key) => this.#handleKeypress(sequence, key),
      onResize: () => {
        for (const listener of this.#resizeListeners) listener();
      },
      onOutputError: (error) => {
        for (const listener of this.#errorListeners) listener(error);
      },
    });
  }

  bindProcessHandlers(
    handlers: TerminalProcessHandlers,
    target?: Pick<NodeJS.Process, "on" | "off">,
  ): () => void {
    return this.#lifecycle.bindProcessHandlers(handlers, target);
  }

  restore(): void {
    this.#pasteBuffer = undefined;
    this.#lifecycle.restore();
    this.#keyListeners.clear();
    this.#resizeListeners.clear();
    this.#errorListeners.clear();
  }

  write(value: string): void {
    this.#lifecycle.write(value);
  }

  hideCursor(): void {
    this.#lifecycle.hideCursor();
  }

  showCursor(): void {
    this.#lifecycle.showCursor();
  }

  clearActiveRegion(): void {
    if (!this.isInteractive) return;
    this.#lifecycle.write("\r\x1b[0J");
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
    if (!this.isInteractive) {
      this.#lifecycle.write(`${lines.join("\n")}\n`);
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
    if (result.output) this.#lifecycle.writeFrame(result.output);
    result.commit();
    return { requiresFullReplay: false, stats: result.stats };
  }

  moveCursorTo(row: number, column: number): void {
    if (!this.isInteractive) return;
    this.#lifecycle.write(`\x1b[${Math.max(0, row + 1)};${Math.max(0, column + 1)}H`);
  }

  clearLine(): void {
    if (!this.isInteractive) return;
    this.#lifecycle.write("\x1b[2K\r");
  }

  #handleKeypress(sequence: string, key: import("node:readline").Key): void {
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
    const input: {
      sequence: string;
      name?: string;
      ctrl?: boolean;
      meta?: boolean;
      shift?: boolean;
    } = { sequence };
    if (key.name !== undefined) input.name = key.name;
    if (key.ctrl !== undefined) input.ctrl = key.ctrl;
    if (key.meta !== undefined) input.meta = key.meta;
    if (key.shift !== undefined) input.shift = key.shift;
    const composition = (key as import("./types.js").KeyInput).composition;
    this.#emitKeypress(composition === undefined ? input : { ...input, composition });
  }

  #emitKeypress(input: KeyInput): void {
    for (const listener of this.#keyListeners) listener(input);
  }
}
