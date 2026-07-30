import type { ComponentAction, KeyInput, OverlayFrame, OverlayHandle } from "./types.js";

interface OverlayEntry {
  readonly overlay: OverlayFrame;
  readonly order: number;
  visible: boolean;
}

export class OverlayHost {
  readonly #entries: OverlayEntry[] = [];
  #sequence = 0;

  get overlays(): readonly OverlayFrame[] {
    return this.#entries
      .filter((entry) => entry.visible)
      .map((entry) => entry.overlay);
  }

  get top(): OverlayFrame | undefined {
    return this.#entries.at(-1)?.overlay;
  }

  push(overlay: OverlayFrame): OverlayHandle {
    const entry: OverlayEntry = {
      overlay,
      order: this.#sequence += 1,
      visible: true,
    };
    this.#entries.push(entry);
    this.#entries.sort(compareEntries);
    return {
      hide: () => {
        entry.visible = false;
        this.#compact();
      },
      isVisible: () => entry.visible,
    };
  }

  clear(): void {
    for (const entry of this.#entries) {
      entry.visible = false;
    }
    this.#compact();
  }

  remove(id: string): void {
    const entry = this.#entries.find((candidate) => candidate.overlay.id === id);
    if (!entry) {
      return;
    }
    entry.visible = false;
    this.#compact();
  }

  handleInput(input: KeyInput): ComponentAction | void {
    const overlay = this.top;
    if (!overlay) {
      return undefined;
    }
    const action = overlay.handleInput?.(input);
    if (action?.type === "cancel") {
      this.remove(overlay.id);
      return { type: "none" };
    }
    return action ?? { type: "none" };
  }

  render(width: number, height?: number): string[] {
    const overlay = this.top;
    if (!overlay) {
      return [];
    }
    return overlay.render(width, height);
  }

  #compact(): void {
    this.#entries.splice(0, this.#entries.length, ...this.#entries.filter((entry) => entry.visible));
  }
}

function compareEntries(left: OverlayEntry, right: OverlayEntry): number {
  if (left.overlay.priority === right.overlay.priority) {
    return left.order - right.order;
  }
  return left.overlay.priority - right.overlay.priority;
}
