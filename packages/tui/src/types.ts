export interface KeyInput {
  readonly sequence: string;
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly composition?: "start" | "update" | "commit" | "cancel";
}

export interface Component {
  render(width: number, height?: number): string[];
  handleInput?(input: KeyInput): ComponentAction | void;
  invalidate(): void;
}

export interface PreparedRenderFrame {
  readonly lines: string[];
  readonly commitPrefixLineCount?: number;
  commit?(): void;
}

export interface InlineFrameComponent extends Component {
  prepareFrame(
    width: number,
    height: number | undefined,
    options: { readonly full: boolean },
  ): PreparedRenderFrame;
}

export type ComponentAction =
  | { type: "submit"; value: string }
  | { type: "cancel" }
  | { type: "none" };

export interface OverlayHandle {
  hide(): void;
  isVisible(): boolean;
}

export interface OverlayFrame extends Component {
  readonly id: string;
  readonly priority: number;
}

export const CURSOR_MARKER = "\u001b_pi:c\u0007";
export const SELECTION_START = "\u001b[7m";
export const SELECTION_END = "\u001b[27m";
export const COMPOSITION_START = "\u001b[4m";
export const COMPOSITION_END = "\u001b[24m";
