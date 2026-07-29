export interface KeyInput {
  readonly sequence: string;
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

export interface Component {
  render(width: number): string[];
  handleInput?(input: KeyInput): ComponentAction | void;
  invalidate(): void;
}

export type ComponentAction =
  | { type: "submit"; value: string }
  | { type: "cancel" }
  | { type: "none" };

export interface OverlayHandle {
  hide(): void;
  isVisible(): boolean;
}

export const CURSOR_MARKER = "\u001b_pi:c\u0007";

