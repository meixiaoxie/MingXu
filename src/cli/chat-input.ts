import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, clearScreenDown } from "node:readline";

import stringWidth from "string-width";

import { CHAT_COMMANDS, formatChatHelp, suggestChatCommands } from "./chat-commands.js";

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
  #buffer = "";
  #menuVisible = false;
  #menuIndex = 0;
  #resolver: ((value: string | null) => void) | undefined;
  #lineInterface: import("node:readline/promises").Interface | undefined;
  #abortCallback: (() => void) | undefined;
  #keypressHandler: ((str: string, key: import("node:readline").Key) => void) | undefined;

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
    this.#buffer = "";
    this.#menuVisible = false;
    this.#menuIndex = 0;

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

        if (key.name === "return" || key.name === "enter") {
          const trimmed = this.#buffer.trim();
          if (trimmed === "/") {
            this.#showHelp(prompt);
            return;
          }
          if (this.#menuVisible && this.#suggestions().length > 0) {
            const completion = this.#selectedCompletion();
            if (completion) {
              this.#buffer = completion;
              this.#render(prompt);
              this.#finish(this.#buffer);
              return;
            }
          }
          this.#finish(this.#buffer);
          return;
        }

        if (key.name === "backspace") {
          this.#buffer = this.#buffer.slice(0, -1);
          this.#menuVisible = this.#buffer.startsWith("/");
          this.#menuIndex = 0;
          this.#render(prompt);
          return;
        }

        if (key.name === "escape") {
          if (this.#menuVisible) {
            this.#menuVisible = false;
            this.#render(prompt);
            return;
          }
          this.#buffer = "";
          this.#render(prompt);
          return;
        }

        if (key.name === "tab") {
          const suggestions = this.#suggestions();
          if (suggestions.length > 0) {
            this.#menuVisible = true;
            const selected = suggestions[this.#menuIndex] ?? suggestions[0]!;
            this.#buffer = selected.usage.split(" ")[0] ?? `/${selected.name}`;
            if (!this.#buffer.startsWith("/")) {
              this.#buffer = `/${selected.name}`;
            }
            if (!this.#buffer.endsWith(" ")) {
              this.#buffer += " ";
            }
            this.#menuIndex = Math.min(this.#menuIndex, suggestions.length - 1);
            this.#render(prompt);
          }
          return;
        }

        if (key.name === "up") {
          const suggestions = this.#suggestions();
          if (suggestions.length > 0) {
            this.#menuVisible = true;
            this.#menuIndex = (this.#menuIndex - 1 + suggestions.length) % suggestions.length;
            this.#render(prompt);
          }
          return;
        }

        if (key.name === "down") {
          const suggestions = this.#suggestions();
          if (suggestions.length > 0) {
            this.#menuVisible = true;
            this.#menuIndex = (this.#menuIndex + 1) % suggestions.length;
            this.#render(prompt);
          }
          return;
        }

        if (str) {
          this.#buffer += str;
          this.#menuVisible = this.#buffer.startsWith("/");
          this.#menuIndex = 0;
          this.#render(prompt);
        }
      };

      this.#input.on("keypress", this.#keypressHandler);
      this.#render(prompt);
    });
  }

  async #readLineFallback(prompt: string): Promise<string | null> {
    this.#lineInterface?.close();
    this.#lineInterface = createInterface({
      input: this.#input,
      output: this.#output,
      completer: (line: string) => {
        const suggestions = this.#suggestionsFor(line);
        const completions: [string[], string] = [suggestions.map((command) => `/${command.name}`), line];
        return completions;
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

  #render(prompt: string): void {
    if (!this.#output.isTTY) {
      return;
    }

    const suggestions = this.#menuVisible ? this.#suggestions() : [];
    const usageWidth = Math.max(...CHAT_COMMANDS.map((item) => stringWidth(item.usage)), 0);
    const inlineMenu = suggestions.length > 0
      ? `  ${suggestions.slice(0, 6).map((command, index) => {
          const marker = index === this.#menuIndex ? ">" : " ";
          const paddedUsage = command.usage.padEnd(usageWidth);
          return `${marker} ${paddedUsage}`;
        }).join("   ")}`
      : "";

    this.#output.write("\r");
    clearScreenDown(this.#output);
    this.#output.write(`${prompt}${this.#buffer}${inlineMenu}`);
  }

  #showHelp(prompt: string): void {
    this.#menuVisible = false;
    this.#render(prompt);
    this.#output.write(`\n${formatChatHelp()}\n`);
    this.#render(prompt);
  }

  #suggestions(): readonly typeof CHAT_COMMANDS[number][] {
    return suggestChatCommands(this.#buffer);
  }

  #suggestionsFor(line: string): readonly typeof CHAT_COMMANDS[number][] {
    return suggestChatCommands(line);
  }

  #selectedCompletion(): string | undefined {
    const suggestions = this.#suggestions();
    const selected = suggestions[this.#menuIndex];
    if (!selected) {
      return undefined;
    }
    return `/${selected.name}`;
  }
}
