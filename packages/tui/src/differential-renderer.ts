/*
 * Viewport-aware differential rendering adapted from pi-mono's pi-tui
 * renderer at commit 2efa728d2ee90ef597626e96b1e28ef2b279f07c
 * (packages/tui/src/tui.ts, @earendil-works/pi-tui 0.82.1, MIT).
 * MingXu keeps only the active-region line diff and transcript-promotion
 * behavior. See THIRD_PARTY_NOTICES.md and LICENSES/pi-mono-MIT.txt.
 */

import { visibleWidth } from "./strings.js";
import { CURSOR_MARKER } from "./types.js";

export type FullReplayReason = "initial" | "requested" | "width-change" | "height-change" | "outside-viewport";

export interface DifferentialRenderStats {
  readonly activeLineCount: number;
  readonly committedLineCount: number;
  readonly renderedLineCount: number;
  readonly fullRedrawCount: number;
  readonly lastFullRedrawReason?: FullReplayReason;
}

export interface DifferentialRenderResult {
  readonly output: string;
  readonly requiresFullReplay: boolean;
  readonly replayReason?: FullReplayReason;
  readonly stats: DifferentialRenderStats;
  commit(): void;
}

interface CursorPosition {
  readonly row: number;
  readonly column: number;
}

interface NextRendererState {
  readonly lines: string[];
  readonly width: number;
  readonly height: number;
  readonly hardwareCursorRow: number;
  readonly viewportTop: number;
  readonly cursorPosition?: CursorPosition;
  readonly renderedLineCount: number;
  readonly fullRedrawReason?: FullReplayReason;
}

export class DifferentialRenderer {
  #previousLines: readonly string[] = [];
  #previousWidth = 0;
  #previousHeight = 0;
  #hardwareCursorRow = 0;
  #viewportTop = 0;
  #hasRendered = false;
  #committedLineCount = 0;
  #fullRedrawCount = 0;
  #lastFullRedrawReason: FullReplayReason | undefined;
  #renderedLineCount = 0;

  get stats(): DifferentialRenderStats {
    return {
      activeLineCount: this.#previousLines.length,
      committedLineCount: this.#committedLineCount,
      renderedLineCount: this.#renderedLineCount,
      fullRedrawCount: this.#fullRedrawCount,
      ...(this.#lastFullRedrawReason ? { lastFullRedrawReason: this.#lastFullRedrawReason } : {}),
    };
  }

  render(
    sourceLines: readonly string[],
    size: { readonly columns: number; readonly rows: number },
    options: {
      readonly full?: boolean;
      readonly fullReason?: FullReplayReason;
      readonly commitPrefixLineCount?: number;
    } = {},
  ): DifferentialRenderResult {
    const lines = [...sourceLines];
    const cursorPosition = extractCursorPosition(lines, size.rows);
    const commitPrefixLineCount = clampCommitPrefix(options.commitPrefixLineCount, lines.length);
    const requestedFull = options.full === true;

    if (!requestedFull && this.#hasRendered && this.#previousWidth !== size.columns) {
      return this.#replayRequired("width-change");
    }
    if (requestedFull || !this.#hasRendered) {
      const reason: FullReplayReason = requestedFull ? (options.fullReason ?? "requested") : "initial";
      const output = fullFrame(lines, cursorPosition, size.rows);
      const finalCursorRow = cursorPosition?.row ?? Math.max(0, lines.length - 1);
      const state: NextRendererState = {
        lines,
        width: size.columns,
        height: size.rows,
        hardwareCursorRow: finalCursorRow,
        viewportTop: Math.max(0, lines.length - size.rows),
        ...(cursorPosition ? { cursorPosition } : {}),
        renderedLineCount: lines.length,
        fullRedrawReason: reason,
      };
      return this.#result(output, state, commitPrefixLineCount);
    }

    const resizedViewportTop = this.#hasRendered && this.#previousHeight !== size.rows
      ? Math.max(-this.#committedLineCount, this.#viewportTop + this.#previousHeight - size.rows)
      : this.#viewportTop;
    const firstChanged = findFirstChanged(this.#previousLines, lines);
    if (firstChanged === -1) {
      const output = positionOnlyFrame(this.#hardwareCursorRow, resizedViewportTop, cursorPosition);
      const state: NextRendererState = {
        lines,
        width: size.columns,
        height: size.rows,
        hardwareCursorRow: cursorPosition?.row ?? this.#hardwareCursorRow,
        viewportTop: resizedViewportTop,
        ...(cursorPosition ? { cursorPosition } : {}),
        renderedLineCount: 0,
      };
      return this.#result(output, state, commitPrefixLineCount);
    }

    const lastChanged = findLastChanged(this.#previousLines, lines, firstChanged);
    const appendOnly = firstChanged === this.#previousLines.length && lines.length > this.#previousLines.length;
    const firstTargetRow = appendOnly ? Math.max(0, firstChanged - 1) : Math.min(firstChanged, Math.max(0, lines.length - 1));
    if (firstTargetRow < resizedViewportTop) {
      return this.#replayRequired("outside-viewport");
    }

    const frame = ["\x1b[?2026h", "\x1b[?25l"];
    let viewportTop = resizedViewportTop;
    let hardwareCursorRow = this.#hardwareCursorRow;

    const moveToRow = (targetRow: number): void => {
      const currentScreenRow = hardwareCursorRow - viewportTop;
      const targetScreenRow = targetRow - viewportTop;
      if (targetScreenRow >= size.rows) {
        const moveToBottom = Math.max(0, size.rows - 1 - currentScreenRow);
        if (moveToBottom > 0) frame.push(`\x1b[${moveToBottom}B`);
        const scrollCount = targetScreenRow - size.rows + 1;
        frame.push("\r\n".repeat(scrollCount));
        viewportTop += scrollCount;
      } else {
        const difference = targetRow - hardwareCursorRow;
        if (difference > 0) frame.push(`\x1b[${difference}B`);
        if (difference < 0) frame.push(`\x1b[${-difference}A`);
      }
      hardwareCursorRow = targetRow;
    };

    let renderedLineCount = 0;
    let finalCursorRow = firstTargetRow;
    if (appendOnly) {
      moveToRow(firstTargetRow);
      frame.push("\r\n");
      finalCursorRow = firstChanged;
      if (finalCursorRow - viewportTop >= size.rows) viewportTop = finalCursorRow - size.rows + 1;
    } else {
      moveToRow(firstTargetRow);
      frame.push("\r");
      finalCursorRow = firstChanged;
    }

    const renderEnd = Math.min(lastChanged, lines.length - 1);
    for (let row = firstChanged; row <= renderEnd; row += 1) {
      if (row > firstChanged) {
        frame.push("\r\n");
        if (row - viewportTop >= size.rows) viewportTop = row - size.rows + 1;
      }
      frame.push("\x1b[2K\r", lines[row] ?? "");
      finalCursorRow = row;
      renderedLineCount += 1;
    }

    if (lines.length < this.#previousLines.length) {
      const clearFrom = Math.max(lines.length, firstChanged);
      for (let row = clearFrom; row < this.#previousLines.length; row += 1) {
        if (row < viewportTop || row - viewportTop >= size.rows) continue;
        moveToRow(row);
        frame.push("\r\x1b[2K");
      }
      const endRow = Math.max(0, lines.length - 1);
      if (endRow < viewportTop) {
        return this.#replayRequired("outside-viewport");
      }
      moveToRow(endRow);
      finalCursorRow = endRow;
    } else {
      hardwareCursorRow = finalCursorRow;
    }

    const positioned = appendCursorPosition(frame, hardwareCursorRow, viewportTop, cursorPosition);
    hardwareCursorRow = positioned;
    frame.push("\x1b[?25h", "\x1b[?2026l");

    const state: NextRendererState = {
      lines,
      width: size.columns,
      height: size.rows,
      hardwareCursorRow,
      viewportTop,
      ...(cursorPosition ? { cursorPosition } : {}),
      renderedLineCount,
    };
    return this.#result(frame.join(""), state, commitPrefixLineCount);
  }

  #replayRequired(reason: FullReplayReason): DifferentialRenderResult {
    return {
      output: "",
      requiresFullReplay: true,
      replayReason: reason,
      stats: this.stats,
      commit: () => undefined,
    };
  }

  #result(output: string, state: NextRendererState, commitPrefixLineCount: number): DifferentialRenderResult {
    let committed = false;
    const nextStats = (): DifferentialRenderStats => ({
      activeLineCount: state.lines.length - commitPrefixLineCount,
      committedLineCount: state.fullRedrawReason
        ? commitPrefixLineCount
        : this.#committedLineCount + commitPrefixLineCount,
      renderedLineCount: state.renderedLineCount,
      fullRedrawCount: this.#fullRedrawCount + (state.fullRedrawReason ? 1 : 0),
      ...(state.fullRedrawReason
        ? { lastFullRedrawReason: state.fullRedrawReason }
        : this.#lastFullRedrawReason
          ? { lastFullRedrawReason: this.#lastFullRedrawReason }
          : {}),
    });
    return {
      output,
      requiresFullReplay: false,
      stats: nextStats(),
      commit: () => {
        if (committed) return;
        committed = true;
        this.#previousLines = state.lines.slice(commitPrefixLineCount);
        this.#previousWidth = state.width;
        this.#previousHeight = state.height;
        this.#hardwareCursorRow = state.hardwareCursorRow - commitPrefixLineCount;
        this.#viewportTop = state.viewportTop - commitPrefixLineCount;
        this.#hasRendered = true;
        this.#renderedLineCount = state.renderedLineCount;
        this.#committedLineCount = state.fullRedrawReason
          ? commitPrefixLineCount
          : this.#committedLineCount + commitPrefixLineCount;
        if (state.fullRedrawReason) {
          this.#fullRedrawCount += 1;
          this.#lastFullRedrawReason = state.fullRedrawReason;
        }
      },
    };
  }
}

function fullFrame(lines: readonly string[], cursorPosition: CursorPosition | undefined, height: number): string {
  const frame = ["\x1b[?2026h", "\x1b[?25l", "\x1b[2J\x1b[H", lines.join("\r\n")];
  appendCursorPosition(frame, Math.max(0, lines.length - 1), Math.max(0, lines.length - height), cursorPosition);
  frame.push("\x1b[?25h", "\x1b[?2026l");
  return frame.join("");
}

function positionOnlyFrame(
  hardwareCursorRow: number,
  viewportTop: number,
  cursorPosition: CursorPosition | undefined,
): string {
  if (!cursorPosition) return "";
  const frame = ["\x1b[?2026h", "\x1b[?25l"];
  appendCursorPosition(frame, hardwareCursorRow, viewportTop, cursorPosition);
  frame.push("\x1b[?25h", "\x1b[?2026l");
  return frame.join("");
}

function appendCursorPosition(
  frame: string[],
  hardwareCursorRow: number,
  viewportTop: number,
  cursorPosition: CursorPosition | undefined,
): number {
  if (!cursorPosition) return hardwareCursorRow;
  const difference = cursorPosition.row - hardwareCursorRow;
  if (cursorPosition.row >= viewportTop) {
    if (difference > 0) frame.push(`\x1b[${difference}B`);
    if (difference < 0) frame.push(`\x1b[${-difference}A`);
    frame.push("\r");
    if (cursorPosition.column > 0) frame.push(`\x1b[${cursorPosition.column}C`);
    return cursorPosition.row;
  }
  return hardwareCursorRow;
}

function extractCursorPosition(lines: string[], height: number): CursorPosition | undefined {
  const viewportTop = Math.max(0, lines.length - height);
  for (let row = lines.length - 1; row >= viewportTop; row -= 1) {
    const line = lines[row];
    if (line === undefined) continue;
    const markerIndex = line.indexOf(CURSOR_MARKER);
    if (markerIndex === -1) continue;
    lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
    return { row, column: visibleWidth(line.slice(0, markerIndex)) };
  }
  return undefined;
}

function findFirstChanged(previous: readonly string[], next: readonly string[]): number {
  const limit = Math.max(previous.length, next.length);
  for (let index = 0; index < limit; index += 1) {
    if ((previous[index] ?? "") !== (next[index] ?? "")) return index;
  }
  return -1;
}

function findLastChanged(previous: readonly string[], next: readonly string[], firstChanged: number): number {
  let index = Math.max(previous.length, next.length) - 1;
  while (index > firstChanged && (previous[index] ?? "") === (next[index] ?? "")) index -= 1;
  return index;
}

function clampCommitPrefix(value: number | undefined, lineCount: number): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(lineCount, Math.trunc(value)));
}
