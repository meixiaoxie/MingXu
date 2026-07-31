import { clearScreenDown, emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";

import { Editor, CURSOR_MARKER, visibleWidth, type KeyInput } from "@mingxu/tui";
import { formatChatHelp, suggestChatCommands } from "./chat-commands.js";

export interface ChatInputOptions {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
  readonly enableRawMode?: boolean;
}

export class ChatInputController {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;
  readonly #rawModeEnabled: boolean;
  #active = false;
  #resolver: ((value: string | null) => void) | undefined;
  #lineInterface: import("node:readline/promises").Interface | undefined;
  #abortCallback: (() => void) | undefined;
  #keypressHandler: ((str: string, key: import("node:readline").Key) => void) | undefined;
  #editor: Editor | undefined;

  constructor(options: ChatInputOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#rawModeEnabled = options.enableRawMode ?? false;
  }

  setAbortCallback(callback: (() => void) | undefined): void {
    this.#abortCallback = callback;
  }

  async readLine(prompt: string): Promise<string | null> {
    if (this.#rawModeEnabled && this.#input.isTTY && this.#output.isTTY && typeof this.#input.setRawMode === "function") {
      return this.#readLineRaw(prompt);
    }
    return this.#readLineFallback(prompt);
  }

  close(): void {
    this.#disposeRawMode();
    this.#lineInterface?.close();
    this.#lineInterface = undefined;
  }

  #readLineRaw(prompt: string): Promise<string | null> {
    this.#disposeRawMode();
    emitKeypressEvents(this.#input);
    this.#input.setRawMode?.(true);
    this.#input.resume();
    this.#active = true;
    this.#editor = new Editor({
      prompt,
      placeholder: "Ctrl+J inserts a newline",
      completionProvider: (value) => suggestChatCommands(value).map((command) => ({
        id: command.name,
        label: command.usage,
        description: command.description,
      })),
    });

    return new Promise((resolve) => {
      this.#resolver = resolve;
      this.#keypressHandler = (str, key) => {
        if (!this.#active) {
          return;
        }

        if (key.ctrl && key.name === "c") {
          if (this.#abortCallback) {
            this.#abortCallback();
            return;
          }
          this.#finish(null);
          return;
        }

        const action = this.#editor?.handleInput(createKeyInput(str, key));

        if (action?.type === "cancel") {
          this.#finish(null);
          return;
        }

        if (action?.type === "submit") {
          if (action.value.trim() === "/") {
            this.#renderHelp();
            return;
          }
          this.#finish(action.value);
          return;
        }

        this.#render();
      };

      this.#input.on("keypress", this.#keypressHandler);
      this.#render();
    });
  }

  async #readLineFallback(prompt: string): Promise<string | null> {
    this.#lineInterface?.close();
    this.#lineInterface = createInterface({
      input: this.#input,
      output: this.#output,
      completer: (line: string) => {
        const suggestions = suggestChatCommands(line);
        return [suggestions.map((command) => `/${command.name}`), line] as [string[], string];
      },
    });

    while (true) {
      const line = await this.#lineInterface.question(prompt);
      if (line.trim() === "/") {
        this.#output.write(`${formatChatHelp()}\n`);
        continue;
      }
      return line;
    }
  }

  #disposeRawMode(): void {
    if (this.#keypressHandler) {
      this.#input.off("keypress", this.#keypressHandler);
      this.#keypressHandler = undefined;
    }
    if (typeof this.#input.setRawMode === "function") {
      this.#input.setRawMode(false);
    }
    this.#active = false;
    this.#editor = undefined;
    this.#resolver = undefined;
  }

  #finish(value: string | null): void {
    const resolve = this.#resolver;
    this.#disposeRawMode();
    this.#clearPrompt();
    resolve?.(value);
  }

  #clearPrompt(): void {
    if (!this.#output.isTTY) {
      return;
    }
    this.#output.write("\r");
    clearScreenDown(this.#output);
  }

  #render(): void {
    if (!this.#output.isTTY) {
      return;
    }
    this.#output.write("\r");
    clearScreenDown(this.#output);
    const rendered = this.#editor?.render(this.#output.columns || 80) ?? [];
    let cursorRow = rendered.length - 1;
    let cursorColumn = visibleWidth(rendered.at(-1) ?? "");
    let cursorFound = false;
    const lines = rendered.map((line, row) => {
      const markerIndex = line.indexOf(CURSOR_MARKER);
      if (markerIndex >= 0) {
        cursorRow = row;
        cursorColumn = visibleWidth(line.slice(0, markerIndex));
        cursorFound = true;
      }
      return line.replace(CURSOR_MARKER, "");
    });
    this.#output.write(lines.join("\n"));
    if (cursorFound) {
      const rowsUp = Math.max(0, lines.length - 1 - cursorRow);
      if (rowsUp > 0) {
        this.#output.write(`\u001b[${rowsUp}A`);
      }
      this.#output.write("\r");
      if (cursorColumn > 0) {
        this.#output.write(`\u001b[${cursorColumn + 1}G`);
      }
    }
  }

  #renderHelp(): void {
    this.#render();
    this.#output.write(`\n${formatChatHelp()}\n`);
    this.#render();
  }
}

function createKeyInput(sequence: string, key: import("node:readline").Key): KeyInput {
  const input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean } = { sequence };
  if (key.name !== undefined) {
    input.name = key.name;
  }
  if (key.ctrl !== undefined) {
    input.ctrl = key.ctrl;
  }
  if (key.meta !== undefined) {
    input.meta = key.meta;
  }
  if (key.shift !== undefined) {
    input.shift = key.shift;
  }
  const composition = (key as KeyInput).composition;
  return composition === undefined ? input : { ...input, composition };
}
