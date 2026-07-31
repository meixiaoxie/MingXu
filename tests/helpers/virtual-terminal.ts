import { EventEmitter } from "node:events";

import headless from "@xterm/headless";

import { ProcessTerminal, type KeyInput } from "@mingxu/tui";

interface HeadlessBufferLine {
  translateToString(trimRight?: boolean): string;
}

interface HeadlessBuffer {
  readonly active: {
    readonly length: number;
    readonly baseY: number;
    getLine(index: number): HeadlessBufferLine | undefined;
  };
}

interface HeadlessTerminal {
  write(data: string | Uint8Array, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  readonly buffer: HeadlessBuffer;
}

export interface VirtualTerminal {
  readonly terminal: ProcessTerminal;
  readonly screen: HeadlessTerminal;
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
  readonly writes: readonly string[];
  press(input: KeyInput): void;
  resize(columns: number, rows: number): void;
  flush(): Promise<void>;
  readLines(): Promise<string[]>;
  readText(): Promise<string>;
}

export function createVirtualTerminal(options: {
  readonly columns?: number;
  readonly rows?: number;
  readonly scrollback?: number;
} = {}): VirtualTerminal {
  const terminalModule = headless as unknown as { Terminal: new (options: Record<string, unknown>) => HeadlessTerminal };
  const screen = new terminalModule.Terminal({
    allowProposedApi: true,
    cols: options.columns ?? 80,
    rows: options.rows ?? 24,
    scrollback: options.scrollback ?? 1_000,
  });
  const inputEmitter = new EventEmitter();
  const outputEmitter = new EventEmitter();
  const writes: string[] = [];
  let columns = options.columns ?? 80;
  let rows = options.rows ?? 24;
  let pending = Promise.resolve();

  const output = Object.assign(outputEmitter, {
    isTTY: true,
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    write(chunk: string) {
      writes.push(String(chunk));
      pending = pending.then(() => new Promise<void>((resolve) => {
        screen.write(chunk, resolve);
      }));
      return true;
    },
  }) as unknown as NodeJS.WriteStream;

  const input = Object.assign(inputEmitter, {
    isTTY: true,
    resume() {},
    setRawMode() {},
  }) as unknown as NodeJS.ReadStream;

  const terminal = new ProcessTerminal(input, output);
  const flush = async (): Promise<void> => {
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await pending;
  };
  const readLines = async (): Promise<string[]> => {
    await flush();
    const lines: string[] = [];
    const buffer = screen.buffer.active;
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return lines;
  };
  const readText = async (): Promise<string> => (await readLines()).join("\n");

  return {
    terminal,
    screen,
    input,
    output,
    writes,
    press(key: KeyInput): void {
      inputEmitter.emit("keypress", key.sequence, key);
    },
    resize(nextColumns: number, nextRows: number): void {
      columns = nextColumns;
      rows = nextRows;
      screen.resize(nextColumns, nextRows);
      outputEmitter.emit("resize");
    },
    flush,
    readLines,
    readText,
  };
}
