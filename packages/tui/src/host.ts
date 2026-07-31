import type { Component, InlineFrameComponent, PreparedRenderFrame } from "./types.js";
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
    let full = this.#forceFullRender;
    let frame = this.#prepareFrame(full);
    let result = this.#terminal.render(frame.lines, {
      full,
      ...(frame.commitPrefixLineCount !== undefined
        ? { commitPrefixLineCount: frame.commitPrefixLineCount }
        : {}),
    });
    if (result?.requiresFullReplay && !full) {
      full = true;
      frame = this.#prepareFrame(true);
      result = this.#terminal.render(frame.lines, {
        full: true,
        ...(result.replayReason ? { fullReason: result.replayReason } : {}),
        ...(frame.commitPrefixLineCount !== undefined
          ? { commitPrefixLineCount: frame.commitPrefixLineCount }
          : {}),
      });
    }
    if (result?.requiresFullReplay) {
      throw new Error(`Terminal renderer could not recover${result.replayReason ? `: ${result.replayReason}` : ""}.`);
    }
    frame.commit?.();
    this.#forceFullRender = false;
    this.#lastRenderAt = Date.now();
  }

  #prepareFrame(full: boolean): PreparedRenderFrame {
    if (isInlineFrameComponent(this.#root)) {
      return this.#root.prepareFrame(
        this.#terminal.size.columns,
        this.#terminal.size.rows,
        { full },
      );
    }
    return { lines: this.#root.render(this.#terminal.size.columns, this.#terminal.size.rows) };
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

function isInlineFrameComponent(component: Component): component is InlineFrameComponent {
  return "prepareFrame" in component && typeof component.prepareFrame === "function";
}
