import type { Component } from "./types.js";
import type { ProcessTerminal } from "./terminal.js";

export const DEFAULT_FRAME_INTERVAL_MS = 1000 / 30;

export class TuiHost {
  readonly #terminal: ProcessTerminal;
  #root: Component;
  #renderPending = false;
  #forceFullRender = false;
  #lastRenderAt = Number.NEGATIVE_INFINITY;
  #renderTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(terminal: ProcessTerminal, root: Component) {
    this.#terminal = terminal;
    this.#root = root;
  }

  setRoot(root: Component): void {
    this.#root = root;
    this.requestRender();
  }

  requestRender(options: { readonly full?: boolean } = {}): void {
    if (this.#disposed) {
      return;
    }
    if (options.full === true) {
      this.#forceFullRender = true;
    }
    if (this.#renderPending) {
      return;
    }
    this.#renderPending = true;
    const elapsed = Date.now() - this.#lastRenderAt;
    const delay = Math.max(0, DEFAULT_FRAME_INTERVAL_MS - elapsed);
    if (delay === 0) {
      queueMicrotask(() => this.renderNow());
      return;
    }
    this.#renderTimer = setTimeout(() => this.renderNow(), delay);
    this.#renderTimer.unref?.();
  }

  renderNow(): void {
    if (this.#disposed) {
      return;
    }
    if (this.#renderTimer) {
      clearTimeout(this.#renderTimer);
      this.#renderTimer = undefined;
    }
    this.#renderPending = false;
    this.#terminal.render(this.#root.render(this.#terminal.size.columns, this.#terminal.size.rows), { full: this.#forceFullRender });
    this.#forceFullRender = false;
    this.#lastRenderAt = Date.now();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#renderTimer) {
      clearTimeout(this.#renderTimer);
      this.#renderTimer = undefined;
    }
    this.#renderPending = false;
  }
}
