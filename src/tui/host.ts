import type { Component } from "./types.js";
import type { ProcessTerminal } from "./terminal.js";

export class TuiHost {
  readonly #terminal: ProcessTerminal;
  #root: Component;
  #renderPending = false;

  constructor(terminal: ProcessTerminal, root: Component) {
    this.#terminal = terminal;
    this.#root = root;
  }

  setRoot(root: Component): void {
    this.#root = root;
    this.requestRender();
  }

  requestRender(): void {
    if (this.#renderPending) {
      return;
    }
    this.#renderPending = true;
    queueMicrotask(() => {
      this.#renderPending = false;
      this.renderNow();
    });
  }

  renderNow(): void {
    this.#terminal.render(this.#root.render(this.#terminal.size.columns));
  }
}

