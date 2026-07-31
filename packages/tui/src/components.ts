import { marked, type Token, type Tokens } from "marked";

import {
  COMPOSITION_END,
  COMPOSITION_START,
  CURSOR_MARKER,
  SELECTION_END,
  SELECTION_START,
  type Component,
  type ComponentAction,
  type KeyInput,
} from "./types.js";
import { padToWidth, sanitizeTerminalText, splitGraphemes, truncateToWidth, visibleWidth, wrapText } from "./strings.js";

export interface TextOptions {
  readonly text: string;
}

export class Container implements Component {
  readonly children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }

  invalidate(): void {
    for (const child of this.children) {
      child.invalidate();
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const child of this.children) {
      lines.push(...child.render(width));
    }
    return lines;
  }
}

export class Text implements Component {
  #text: string;

  constructor(options: TextOptions) {
    this.#text = options.text;
  }

  set text(value: string) {
    this.#text = value;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return wrapText(this.#text, width);
  }
}

export class Box implements Component {
  #title: string | undefined;
  #content: Component;

  constructor(content: Component, title?: string) {
    this.#content = content;
    this.#title = title;
  }

  invalidate(): void {
    this.#content.invalidate();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const content = this.#content.render(innerWidth).map((line) => padToWidth(truncateToWidth(line, innerWidth), innerWidth));
    const title = sanitizeTerminalText(this.#title ?? "").trim();
    const top = title.length > 0
      ? `+ ${truncateToWidth(title, innerWidth - 2)} ${"-".repeat(Math.max(0, innerWidth - visibleWidth(title) - 2))}+`
      : `+${"-".repeat(innerWidth)}+`;
    const bottom = `+${"-".repeat(innerWidth)}+`;
    return [top, ...content.map((line) => `|${line}|`), bottom];
  }
}

export interface SelectListItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export class SelectList implements Component {
  #items: readonly SelectListItem[] = [];
  #selectedIndex = 0;
  #title = "";

  constructor(items: readonly SelectListItem[] = [], title = "") {
    this.#items = items;
    this.#title = title;
  }

  setItems(items: readonly SelectListItem[]): void {
    this.#items = items;
    this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, items.length - 1));
  }

  setTitle(title: string): void {
    this.#title = title;
  }

  get selected(): SelectListItem | undefined {
    return this.#items[this.#selectedIndex];
  }

  move(delta: number): void {
    if (this.#items.length === 0) {
      return;
    }
    this.#selectedIndex = (this.#selectedIndex + delta + this.#items.length) % this.#items.length;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const title = sanitizeTerminalText(this.#title);
    const lines = title ? [truncateToWidth(title, width)] : [];
    this.#items.forEach((item, index) => {
      const prefix = index === this.#selectedIndex ? ">" : " ";
      const base = `${prefix} ${sanitizeTerminalText(item.label)}`;
      lines.push(truncateToWidth(base, width));
      if (item.description) {
        lines.push(truncateToWidth(`  ${sanitizeTerminalText(item.description)}`, width));
      }
    });
    return lines;
  }
}

export interface EditorOptions {
  readonly prompt?: string;
  readonly history?: readonly string[];
  readonly placeholder?: string;
  readonly completionProvider?: (value: string) => readonly SelectListItem[];
}

interface CursorPosition {
  readonly row: number;
  readonly column: number;
}

interface EditorSnapshot {
  readonly value: string;
  readonly cursor: number;
  readonly selectionAnchor: number | undefined;
}

export interface EditorSelection {
  readonly anchor: number;
  readonly focus: number;
  readonly start: number;
  readonly end: number;
}

export interface EditorCompositionState {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export class Editor implements Component {
  readonly #prompt: string;
  readonly #placeholder: string;
  readonly #completionProvider: ((value: string) => readonly SelectListItem[]) | undefined;
  readonly #history: string[];
  readonly #promptGraphemeCount: number;
  #value = "";
  #cursor = 0;
  #selectionAnchor: number | undefined;
  #composition: EditorCompositionState | undefined;
  #historyIndex: number | undefined;
  #draftBeforeHistory: string | undefined;
  #completionItems: readonly SelectListItem[] = [];
  #completionIndex = 0;
  #menuVisible = false;
  #completionSuppressed = false;
  #renderWidth = 80;
  #layout: readonly CursorPosition[] = [];
  #undoStack: EditorSnapshot[] = [];
  #redoStack: EditorSnapshot[] = [];

  constructor(options: EditorOptions = {}) {
    this.#prompt = options.prompt ?? "> ";
    this.#placeholder = options.placeholder ?? "";
    this.#completionProvider = options.completionProvider;
    this.#history = [...(options.history ?? [])];
    this.#promptGraphemeCount = splitGraphemes(this.#prompt).length;
  }

  get value(): string {
    return this.#value;
  }

  get cursor(): number {
    return this.#cursor;
  }

  get selection(): EditorSelection | undefined {
    if (this.#selectionAnchor === undefined || this.#selectionAnchor === this.#cursor) {
      return undefined;
    }
    return {
      anchor: this.#selectionAnchor,
      focus: this.#cursor,
      start: Math.min(this.#selectionAnchor, this.#cursor),
      end: Math.max(this.#selectionAnchor, this.#cursor),
    };
  }

  get composition(): EditorCompositionState | undefined {
    return this.#composition;
  }

  clear(): void {
    this.#value = "";
    this.#cursor = 0;
    this.#selectionAnchor = undefined;
    this.#composition = undefined;
    this.#historyIndex = undefined;
    this.#draftBeforeHistory = undefined;
    this.#menuVisible = false;
    this.#completionSuppressed = false;
    this.#completionItems = [];
    this.#completionIndex = 0;
    this.#layout = [];
    this.#undoStack = [];
    this.#redoStack = [];
  }

  pushHistory(value: string): void {
    if (!value.trim()) {
      return;
    }
    this.#history.push(value);
    this.#historyIndex = undefined;
  }

  invalidate(): void {}

  handleInput(input: KeyInput): ComponentAction | void {
    if (input.composition) {
      this.handleComposition(input.composition, input.sequence);
      return { type: "none" };
    }

    if (this.#composition) {
      if (input.name === "escape") {
        this.handleComposition("cancel");
      }
      return { type: "none" };
    }

    if (input.ctrl && input.name === "c") {
      return { type: "cancel" };
    }

    if (input.ctrl && input.name === "z") {
      if (input.shift) {
        this.#redo();
      } else {
        this.#undo();
      }
      return { type: "none" };
    }

    if (input.ctrl && input.name === "y") {
      this.#redo();
      return { type: "none" };
    }

    if (input.name === "return" || input.name === "enter") {
      if (input.shift || input.ctrl) {
        this.#insert("\n");
        return { type: "none" };
      }
      const submitted = this.#value.trim();
      this.pushHistory(this.#value);
      this.clear();
      return submitted ? { type: "submit", value: submitted } : { type: "none" };
    }

    if (input.ctrl && input.name === "j") {
      this.#insert("\n");
      return { type: "none" };
    }

    if (input.name === "backspace") {
      this.#deleteBackward();
      return { type: "none" };
    }

    if (input.name === "delete") {
      this.#deleteForward();
      return { type: "none" };
    }

    if (input.name === "left") {
      this.#moveHorizontal(-1, input.shift === true);
      this.#syncCompletionState();
      return { type: "none" };
    }

    if (input.name === "right") {
      this.#moveHorizontal(1, input.shift === true);
      this.#syncCompletionState();
      return { type: "none" };
    }

    if (input.name === "home" || (input.ctrl && input.name === "a")) {
      this.#setCursor(input.ctrl && input.name === "a"
        ? 0
        : this.#currentLineRange().start, input.shift === true);
      this.#syncCompletionState();
      return { type: "none" };
    }

    if (input.name === "end" || (input.ctrl && input.name === "e")) {
      this.#setCursor(input.ctrl && input.name === "e"
        ? this.#valueGraphemeCount()
        : this.#currentLineRange().end, input.shift === true);
      this.#syncCompletionState();
      return { type: "none" };
    }

    if (input.name === "up") {
      if (this.#menuVisible && this.#completionItems.length > 0) {
        this.#completionIndex = (this.#completionIndex - 1 + this.#completionItems.length) % this.#completionItems.length;
      } else if (!this.#moveVertical(-1, input.shift === true) && !input.shift) {
        this.#historyUp();
      } else if (!input.shift || this.#layout.length > 0) {
        this.#syncCompletionState();
      }
      return { type: "none" };
    }

    if (input.name === "down") {
      if (this.#menuVisible && this.#completionItems.length > 0) {
        this.#completionIndex = (this.#completionIndex + 1) % this.#completionItems.length;
      } else if (!this.#moveVertical(1, input.shift === true) && !input.shift) {
        this.#historyDown();
      } else if (!input.shift || this.#layout.length > 0) {
        this.#syncCompletionState();
      }
      return { type: "none" };
    }

    if (input.name === "escape") {
      if (this.#menuVisible) {
        this.#menuVisible = false;
        this.#completionSuppressed = true;
        this.#completionItems = [];
        this.#completionIndex = 0;
        return { type: "none" };
      }
      return { type: "none" };
    }

    if (input.name === "tab") {
      const selected = this.#completionItems[this.#completionIndex];
      if (selected) {
        this.#applyCompletion(selected);
      }
      return { type: "none" };
    }

    if (input.sequence && input.sequence.length > 0) {
      this.#insert(input.sequence);
      return { type: "none" };
    }

    return undefined;
  }

  handleComposition(phase: "start" | "update" | "commit" | "cancel", text = ""): void {
    switch (phase) {
      case "start":
        if (!this.#composition) {
          const selection = this.selection;
          this.#composition = {
            text: "",
            start: selection?.start ?? this.#cursor,
            end: selection?.end ?? this.#cursor,
          };
        }
        break;
      case "update":
        if (!this.#composition) this.handleComposition("start");
        if (this.#composition) {
          this.#composition = { ...this.#composition, text: normalizeEditorText(text) };
        }
        break;
      case "commit": {
        const composition = this.#composition;
        this.#composition = undefined;
        if (composition) {
          this.#replaceRange(composition.start, composition.end, text);
        } else {
          this.#insert(text);
        }
        break;
      }
      case "cancel":
        this.#composition = undefined;
        break;
    }
    this.#syncCompletionState();
  }

  render(width: number): string[] {
    this.#renderWidth = Math.max(1, width);
    this.#syncCompletionState();
    const lines = this.#buildRenderedLines(this.#renderWidth);

    if (!this.#menuVisible) {
      return lines;
    }

    const menu = this.#completionItems.slice(0, 6).map((item, index) => {
      const marker = index === this.#completionIndex ? ">" : " ";
      const label = item.description ? `${item.label} - ${item.description}` : item.label;
      return truncateToWidth(`${marker} ${label}`, width);
    });
    return [...lines, ...menu];
  }

  #insert(text: string): void {
    const normalized = normalizeEditorText(text);
    if (!normalized) {
      return;
    }
    const selection = this.selection;
    this.#replaceRange(selection?.start ?? this.#cursor, selection?.end ?? this.#cursor, normalized);
  }

  #deleteBackward(): void {
    const selection = this.selection;
    if (selection) {
      this.#replaceRange(selection.start, selection.end, "");
      return;
    }
    if (this.#cursor === 0) {
      return;
    }
    this.#replaceRange(this.#cursor - 1, this.#cursor, "");
  }

  #deleteForward(): void {
    const selection = this.selection;
    if (selection) {
      this.#replaceRange(selection.start, selection.end, "");
      return;
    }
    const value = splitGraphemes(this.#value);
    if (this.#cursor >= value.length) {
      return;
    }
    this.#replaceRange(this.#cursor, this.#cursor + 1, "");
  }

  #replaceRange(start: number, end: number, text: string): void {
    const value = splitGraphemes(this.#value);
    const normalized = normalizeEditorText(text);
    const inserted = splitGraphemes(normalized);
    this.#recordUndo();
    this.#completionSuppressed = false;
    value.splice(start, Math.max(0, end - start), ...inserted);
    this.#value = value.join("");
    this.#cursor = start + inserted.length;
    this.#selectionAnchor = undefined;
    this.#historyIndex = undefined;
    this.#draftBeforeHistory = undefined;
    this.#syncCompletionState();
  }

  #historyUp(): void {
    if (this.#history.length === 0) {
      return;
    }
    this.#completionSuppressed = false;
    if (this.#historyIndex === undefined) {
      this.#draftBeforeHistory = this.#value;
    }
    const nextIndex = this.#historyIndex === undefined ? this.#history.length - 1 : Math.max(0, this.#historyIndex - 1);
    this.#historyIndex = nextIndex;
    this.#value = this.#history[nextIndex] ?? "";
    this.#cursor = this.#valueGraphemeCount();
    this.#selectionAnchor = undefined;
    this.#syncCompletionState();
  }

  #historyDown(): void {
    if (this.#history.length === 0 || this.#historyIndex === undefined) {
      return;
    }
    this.#completionSuppressed = false;
    if (this.#historyIndex >= this.#history.length - 1) {
      this.#historyIndex = undefined;
      this.#value = this.#draftBeforeHistory ?? "";
      this.#draftBeforeHistory = undefined;
      this.#cursor = this.#valueGraphemeCount();
      this.#selectionAnchor = undefined;
      this.#syncCompletionState();
      return;
    }
    this.#historyIndex += 1;
    this.#value = this.#history[this.#historyIndex] ?? "";
    this.#cursor = this.#valueGraphemeCount();
    this.#selectionAnchor = undefined;
    this.#syncCompletionState();
  }

  #applyCompletion(item: SelectListItem): void {
    const value = splitGraphemes(this.#value);
    const prefix = value.slice(0, this.#cursor);
    if (!prefix.join("").startsWith("/")) {
      return;
    }
    this.#recordUndo();
    const suffix = value.slice(this.#cursor);
    const separator = suffix[0] === " " || suffix.length === 0 ? "" : " ";
    const replacement = splitGraphemes(`/${item.id}${separator}`);
    this.#value = [...replacement, ...suffix].join("");
    this.#cursor = replacement.length;
    this.#selectionAnchor = undefined;
    this.#completionSuppressed = true;
    this.#menuVisible = false;
    this.#completionItems = [];
    this.#completionIndex = 0;
  }

  #recordUndo(): void {
    this.#undoStack.push({
      value: this.#value,
      cursor: this.#cursor,
      selectionAnchor: this.#selectionAnchor,
    });
    if (this.#undoStack.length > 100) {
      this.#undoStack.shift();
    }
    this.#redoStack = [];
  }

  #undo(): void {
    const snapshot = this.#undoStack.pop();
    if (!snapshot) {
      return;
    }
    this.#redoStack.push({
      value: this.#value,
      cursor: this.#cursor,
      selectionAnchor: this.#selectionAnchor,
    });
    this.#restoreSnapshot(snapshot);
  }

  #redo(): void {
    const snapshot = this.#redoStack.pop();
    if (!snapshot) {
      return;
    }
    this.#undoStack.push({
      value: this.#value,
      cursor: this.#cursor,
      selectionAnchor: this.#selectionAnchor,
    });
    this.#restoreSnapshot(snapshot);
  }

  #restoreSnapshot(snapshot: EditorSnapshot): void {
    this.#value = snapshot.value;
    this.#cursor = snapshot.cursor;
    this.#selectionAnchor = snapshot.selectionAnchor;
    this.#composition = undefined;
    this.#historyIndex = undefined;
    this.#draftBeforeHistory = undefined;
    this.#completionSuppressed = false;
    this.#syncCompletionState();
  }

  #syncCompletionState(): void {
    if (this.#composition || this.selection || this.#completionSuppressed) {
      this.#menuVisible = false;
      this.#completionItems = [];
      this.#completionIndex = 0;
      return;
    }
    const prefix = splitGraphemes(this.#value).slice(0, this.#cursor).join("");
    if (this.#completionProvider && prefix.startsWith("/")) {
      this.#completionItems = this.#completionProvider(prefix);
      this.#menuVisible = this.#completionItems.length > 0;
      if (this.#completionIndex >= this.#completionItems.length) {
        this.#completionIndex = 0;
      }
      return;
    }

    this.#menuVisible = false;
    this.#completionItems = [];
    this.#completionIndex = 0;
  }

  #valueGraphemeCount(): number {
    return splitGraphemes(this.#value).length;
  }

  #setCursor(cursor: number, extendSelection = false): void {
    const bounded = Math.max(0, Math.min(this.#valueGraphemeCount(), cursor));
    if (extendSelection) {
      if (this.#selectionAnchor === undefined) this.#selectionAnchor = this.#cursor;
      this.#cursor = bounded;
      if (this.#selectionAnchor === this.#cursor) this.#selectionAnchor = undefined;
      return;
    }
    this.#cursor = bounded;
    this.#selectionAnchor = undefined;
  }

  #moveHorizontal(delta: -1 | 1, extendSelection: boolean): void {
    const selection = this.selection;
    if (!extendSelection && selection) {
      this.#setCursor(delta < 0 ? selection.start : selection.end);
      return;
    }
    this.#setCursor(this.#cursor + delta, extendSelection);
  }

  #currentLineRange(): { start: number; end: number } {
    const segments = splitGraphemes(this.#value);
    let start = 0;
    for (let index = 0; index < this.#cursor && index < segments.length; index += 1) {
      if (segments[index] === "\n") {
        start = index + 1;
      }
    }

    let end = segments.length;
    for (let index = this.#cursor; index < segments.length; index += 1) {
      if (segments[index] === "\n") {
        end = index;
        break;
      }
    }

    return { start, end };
  }

  #moveVertical(delta: number, extendSelection = false): boolean {
    if (this.#layout.length === 0) {
      return false;
    }

    const currentIndex = this.#promptGraphemeCount + this.#cursor;
    const current = this.#layout[currentIndex];
    if (!current) {
      return false;
    }

    const targetRow = current.row + delta;
    if (targetRow < 0) {
      return false;
    }

    let chosenIndex: number | undefined;
    let chosenDistance = Number.POSITIVE_INFINITY;
    let chosenColumn = Number.POSITIVE_INFINITY;

    for (let index = this.#promptGraphemeCount; index < this.#layout.length; index += 1) {
      const position = this.#layout[index];
      if (!position || position.row !== targetRow) {
        continue;
      }
      const distance = Math.abs(position.column - current.column);
      if (distance < chosenDistance || (distance === chosenDistance && position.column < chosenColumn)) {
        chosenIndex = index;
        chosenDistance = distance;
        chosenColumn = position.column;
      }
    }

    if (chosenIndex === undefined) {
      return false;
    }

    this.#setCursor(Math.max(0, chosenIndex - this.#promptGraphemeCount), extendSelection);
    this.#syncCompletionState();
    return true;
  }

  #buildRenderedLines(width: number): string[] {
    if (this.#value.length === 0 && !this.#composition) {
      this.#layout = [];
      return wrapText(`${this.#prompt}${this.#placeholder}`, width);
    }

    const promptSegments = splitGraphemes(this.#prompt);
    const valueSegments = splitGraphemes(this.#value);
    const segments = [...promptSegments, ...valueSegments];
    const cursorIndex = this.#promptGraphemeCount + this.#cursor;
    const positions = new Array<CursorPosition>(segments.length + 1);
    const selection = this.selection;
    const selectionStart = selection ? this.#promptGraphemeCount + selection.start : undefined;
    const selectionEnd = selection ? this.#promptGraphemeCount + selection.end : undefined;
    const composition = this.#composition;
    const compositionStart = composition ? this.#promptGraphemeCount + composition.start : undefined;
    const compositionEnd = composition ? this.#promptGraphemeCount + composition.end : undefined;
    const lines: string[] = [];
    let currentLine = "";
    let row = 0;
    let column = 0;
    positions[0] = { row, column };

    const append = (segment: string): void => {
      if (segment === "\n") {
        lines.push(currentLine);
        currentLine = "";
        row += 1;
        column = 0;
        return;
      }

      const segmentWidth = visibleWidth(segment);
      if (column > 0 && column + segmentWidth > width) {
        lines.push(currentLine);
        currentLine = "";
        row += 1;
        column = 0;
      }

      currentLine += segment;
      column += segmentWidth;
    };

    for (let index = 0; index <= segments.length; index += 1) {
      if (compositionStart === index && composition) {
        for (const segment of splitGraphemes(composition.text)) {
          append(segment === "\n" ? segment : `${COMPOSITION_START}${segment}${COMPOSITION_END}`);
        }
        currentLine += CURSOR_MARKER;
      }

      if (index === segments.length) {
        if (!composition && index === cursorIndex) currentLine += CURSOR_MARKER;
        break;
      }

      if (compositionStart !== undefined && compositionEnd !== undefined && index >= compositionStart && index < compositionEnd) {
        positions[index + 1] = { row, column };
        continue;
      }

      if ((!composition || cursorIndex < (compositionStart ?? 0) || cursorIndex > (compositionEnd ?? segments.length)) && index === cursorIndex) {
        currentLine += CURSOR_MARKER;
      }

      const segment = segments[index] ?? "";
      const highlighted = selectionStart !== undefined
        && selectionEnd !== undefined
        && index >= selectionStart
        && index < selectionEnd;
      append(highlighted && segment !== "\n" ? `${SELECTION_START}${segment}${SELECTION_END}` : segment);
      positions[index + 1] = { row, column };
    }

    lines.push(currentLine);
    this.#layout = positions;
    return lines;
  }
}

export class Loader implements Component {
  #frame = 0;
  readonly #frames = ["|", "/", "-", "\\"];

  invalidate(): void {}

  tick(): void {
    this.#frame = (this.#frame + 1) % this.#frames.length;
  }

  render(_width: number): string[] {
    return [this.#frames[this.#frame] ?? "|"];
  }
}

export class Markdown implements Component {
  #text = "";

  constructor(text = "") {
    this.#text = text;
  }

  set text(value: string) {
    this.#text = value;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeText = sanitizeTerminalText(this.#text);
    return renderMarkdownTokens(marked.lexer(safeText, { gfm: true }), Math.max(1, width));
  }
}

export interface TreeNode {
  readonly id: string;
  readonly label: string;
  readonly children?: readonly TreeNode[];
}

export class Tree implements Component {
  #nodes: readonly TreeNode[] = [];

  constructor(nodes: readonly TreeNode[] = []) {
    this.#nodes = nodes;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const visit = (nodes: readonly TreeNode[], prefix: string): void => {
      nodes.forEach((node, index) => {
        const connector = index === nodes.length - 1 ? "`-- " : "|-- ";
        lines.push(truncateToWidth(`${prefix}${connector}${sanitizeTerminalText(node.label)}`, width));
        if (node.children?.length) {
          const childPrefix = width < 24 ? `${prefix}  ` : `${prefix}${index === nodes.length - 1 ? "    " : "|   "}`;
          visit(node.children, childPrefix);
        }
      });
    };
    visit(this.#nodes, "");
    return lines;
  }
}

export class Table implements Component {
  #rows: readonly (readonly string[])[] = [];
  readonly #header: boolean;

  constructor(rows: readonly (readonly string[])[] = [], options: { readonly header?: boolean } = {}) {
    this.#rows = rows;
    this.#header = options.header ?? false;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const rows = this.#rows.map((row) => row.map(sanitizeTerminalText));
    const columnCount = Math.max(0, ...rows.map((row) => row.length));
    if (columnCount === 0) return [];
    if (width < columnCount * 4 + (columnCount - 1) * 3) {
      return rows.flatMap((row, rowIndex) => row.flatMap((cell, columnIndex) => {
        const label = `${rowIndex + 1}.${columnIndex + 1}: `;
        return wrapText(`${label}${cell}`, width);
      }));
    }

    const separatorWidth = (columnCount - 1) * 3;
    const available = Math.max(columnCount * 3, width - separatorWidth);
    const desired = Array.from({ length: columnCount }, (_, columnIndex) => Math.max(3, ...rows.map((row) => visibleWidth(row[columnIndex] ?? ""))));
    const widths = allocateWidths(desired, available, 3);
    const renderRow = (row: readonly string[]): string => row
      .map((cell, index) => padToWidth(truncateToWidth(cell, widths[index] ?? 3), widths[index] ?? 3))
      .join(" | ");
    const lines = rows.map(renderRow);
    if (this.#header && lines.length > 0) {
      lines.splice(1, 0, widths.map((columnWidth) => "-".repeat(columnWidth)).join("-+-"));
    }
    return lines;
  }
}

export class KeyValue implements Component {
  #entries: readonly (readonly [string, string])[] = [];

  constructor(entries: readonly (readonly [string, string])[] = []) {
    this.#entries = entries;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const entries = this.#entries.map(([key, value]) => [sanitizeTerminalText(key), sanitizeTerminalText(value)] as const);
    const keyWidth = Math.min(Math.max(0, ...entries.map(([key]) => visibleWidth(key))), Math.max(1, Math.floor(width * 0.4)));
    if (width < 24 || width - keyWidth - 2 < 8) {
      return entries.flatMap(([key, value]) => [
        truncateToWidth(`${key}:`, width),
        ...wrapText(value, Math.max(1, width - 2)).map((line) => `  ${line}`),
      ]);
    }
    return entries.flatMap(([key, value]) => {
      const prefix = `${padToWidth(truncateToWidth(key, keyWidth), keyWidth)}: `;
      const valueLines = wrapText(value, Math.max(1, width - visibleWidth(prefix)));
      return valueLines.map((line, index) => `${index === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${line}`);
    });
  }
}

export class Progress implements Component {
  #label: string;
  #current: number;
  #total: number;

  constructor(label: string, current: number, total: number) {
    this.#label = label;
    this.#current = current;
    this.#total = Math.max(1, total);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const label = sanitizeTerminalText(this.#label);
    const pct = Math.max(0, Math.min(100, Math.round((this.#current / this.#total) * 100)));
    const suffix = `${pct}%`;
    if (width < 16 || width - visibleWidth(label) - visibleWidth(suffix) - 5 < 4) {
      return [truncateToWidth(`${label} ${suffix}`, width)];
    }
    const barWidth = Math.max(4, width - visibleWidth(label) - visibleWidth(suffix) - 5);
    const filled = Math.round((barWidth * pct) / 100);
    const bar = `[${"=".repeat(filled)}${" ".repeat(Math.max(0, barWidth - filled))}]`;
    return [truncateToWidth(`${label} ${bar} ${suffix}`, width)];
  }
}

export interface DiffOptions {
  readonly collapsed?: boolean;
  readonly maxContextLines?: number;
}

export class Diff implements Component {
  #lines: readonly string[] = [];
  #collapsed: boolean;
  readonly #maxContextLines: number;

  constructor(lines: readonly string[] = [], options: DiffOptions = {}) {
    this.#lines = lines;
    this.#collapsed = options.collapsed ?? false;
    this.#maxContextLines = Math.max(1, options.maxContextLines ?? 6);
  }

  invalidate(): void {}

  setCollapsed(collapsed: boolean): void {
    this.#collapsed = collapsed;
  }

  toggleCollapsed(): void {
    this.#collapsed = !this.#collapsed;
  }

  render(width: number): string[] {
    const entries = parseUnifiedDiff(this.#lines.map(sanitizeTerminalText));
    const headers = entries.filter((entry) => entry.kind === "file");
    if (this.#collapsed) {
      return [
        ...headers.map((entry) => truncateToWidth(entry.text, width)),
        truncateToWidth(`[diff collapsed: ${entries.length - headers.length} lines]`, width),
      ];
    }
    const folded = foldDiffContext(entries, this.#maxContextLines);
    const numberWidth = Math.max(1, ...folded.flatMap((entry) => [entry.oldLine ?? 0, entry.newLine ?? 0]).map((line) => String(line).length));
    return folded.map((entry) => {
      if (entry.kind === "file" || entry.kind === "hunk" || entry.kind === "fold") {
        return truncateToWidth(entry.text, width);
      }
      const oldLine = entry.oldLine === undefined ? " ".repeat(numberWidth) : String(entry.oldLine).padStart(numberWidth);
      const newLine = entry.newLine === undefined ? " ".repeat(numberWidth) : String(entry.newLine).padStart(numberWidth);
      const marker = entry.kind === "add" ? "+" : entry.kind === "delete" ? "-" : " ";
      return truncateToWidth(`${oldLine} ${newLine} | ${marker} ${entry.text}`, width);
    });
  }
}

export type CommandStatus = "running" | "completed" | "failed" | "cancelled";
export type CommandStream = "stdout" | "stderr";

export interface CommandOutputChunk {
  readonly stream: CommandStream;
  readonly text: string;
}

export interface CommandBlockOptions {
  readonly command: string;
  readonly status?: CommandStatus;
  readonly output?: readonly CommandOutputChunk[];
  readonly exitCode?: number;
  readonly signal?: string;
  readonly durationMs?: number;
  readonly maxLines?: number;
  readonly collapsed?: boolean;
  readonly cancellationSummary?: string;
}

export class CommandBlock implements Component {
  readonly #command: string;
  readonly #output: CommandOutputChunk[];
  readonly #maxLines: number;
  #status: CommandStatus;
  #exitCode: number | undefined;
  #signal: string | undefined;
  #durationMs: number | undefined;
  #collapsed: boolean;
  #cancellationSummary: string | undefined;

  constructor(options: CommandBlockOptions) {
    this.#command = sanitizeTerminalText(options.command);
    this.#status = options.status ?? "running";
    this.#output = [...(options.output ?? [])];
    this.#exitCode = options.exitCode;
    this.#signal = options.signal;
    this.#durationMs = options.durationMs;
    this.#maxLines = Math.max(1, options.maxLines ?? 200);
    this.#collapsed = options.collapsed ?? false;
    this.#cancellationSummary = options.cancellationSummary;
  }

  invalidate(): void {}

  append(stream: CommandStream, text: string): void {
    this.#output.push({ stream, text });
  }

  update(result: {
    readonly status: CommandStatus;
    readonly exitCode?: number;
    readonly signal?: string;
    readonly durationMs?: number;
    readonly cancellationSummary?: string;
  }): void {
    this.#status = result.status;
    this.#exitCode = result.exitCode;
    this.#signal = result.signal;
    this.#durationMs = result.durationMs;
    this.#cancellationSummary = result.cancellationSummary;
  }

  setCollapsed(collapsed: boolean): void {
    this.#collapsed = collapsed;
  }

  toggleCollapsed(): void {
    this.#collapsed = !this.#collapsed;
  }

  render(width: number): string[] {
    const details = [
      `status: ${this.#status}`,
      ...(this.#exitCode !== undefined ? [`exit: ${this.#exitCode}`] : []),
      ...(this.#signal !== undefined ? [`signal: ${sanitizeTerminalText(this.#signal)}`] : []),
      ...(this.#durationMs !== undefined ? [`duration: ${formatDuration(this.#durationMs)}`] : []),
    ];
    const header = [
      ...wrapText(`$ ${this.#command}`, width),
      ...details.flatMap((detail) => wrapText(detail, width)),
    ];
    const output = this.#output.flatMap((chunk) => sanitizeTerminalText(chunk.text)
      .split("\n")
      .map((line) => ({ stream: chunk.stream, text: line })));
    if (this.#collapsed) {
      return [...header, truncateToWidth(`[output collapsed: ${output.length} lines]`, width)];
    }
    const omitted = Math.max(0, output.length - this.#maxLines);
    const visible = output.slice(-this.#maxLines).flatMap((line) => {
      const prefix = line.stream === "stderr" ? "err | " : "out | ";
      return wrapText(line.text, Math.max(1, width - visibleWidth(prefix))).map((part) => truncateToWidth(`${prefix}${part}`, width));
    });
    return [
      ...header,
      ...(omitted > 0 ? [truncateToWidth(`[${omitted} earlier output lines omitted]`, width)] : []),
      ...visible,
      ...(this.#cancellationSummary ? wrapText(`cancel: ${sanitizeTerminalText(this.#cancellationSummary)}`, width) : []),
    ];
  }
}

interface DiffEntry {
  readonly kind: "file" | "hunk" | "context" | "add" | "delete" | "fold";
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

function renderMarkdownTokens(tokens: readonly Token[], width: number, indent = ""): string[] {
  const lines: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        if (lines.at(-1) !== "") lines.push("");
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        lines.push(...wrapWithPrefix(`${"#".repeat(heading.depth)} `, renderInline(heading.tokens), width, indent));
        break;
      }
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        lines.push(...wrapWithPrefix("", renderInline(paragraph.tokens), width, indent));
        break;
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        for (const line of renderMarkdownTokens(quote.tokens, Math.max(1, width - 2))) {
          lines.push(truncateToWidth(`${indent}> ${line}`, width));
        }
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        lines.push(truncateToWidth(`${indent}\`\`\`${sanitizeTerminalText(code.lang ?? "")}`, width));
        for (const line of sanitizeTerminalText(code.text).split("\n")) {
          lines.push(truncateToWidth(`${indent}${line}`, width));
        }
        lines.push(truncateToWidth(`${indent}\`\`\``, width));
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        list.items.forEach((item, index) => {
          const marker = list.ordered ? `${Number(list.start || 1) + index}. ` : "- ";
          const itemText = renderInline(item.tokens.flatMap((child) => child.type === "text" && child.tokens ? child.tokens : [child]));
          lines.push(...wrapWithPrefix(marker, itemText, width, indent));
        });
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        const rows = [table.header, ...table.rows].map((row) => row.map((cell) => renderInline(cell.tokens)));
        lines.push(...new Table(rows, { header: true }).render(Math.max(1, width - visibleWidth(indent))).map((line) => `${indent}${line}`));
        break;
      }
      case "hr":
        lines.push(`${indent}${"-".repeat(Math.max(1, width - visibleWidth(indent)))}`);
        break;
      case "html":
        lines.push(...wrapWithPrefix("", sanitizeTerminalText((token as Tokens.HTML).text).replace(/<[^>]*>/gu, ""), width, indent));
        break;
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) {
          lines.push(...renderMarkdownTokens(token.tokens, width, indent));
        } else if ("text" in token && typeof token.text === "string") {
          lines.push(...wrapWithPrefix("", sanitizeTerminalText(token.text), width, indent));
        }
    }
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? lines : [""];
}

function renderInline(tokens: readonly Token[]): string {
  return sanitizeTerminalText(tokens.map((token) => {
    switch (token.type) {
      case "codespan":
        return `\`${(token as Tokens.Codespan).text}\``;
      case "link": {
        const link = token as Tokens.Link;
        return `${renderInline(link.tokens)} (${link.href})`;
      }
      case "image": {
        const image = token as Tokens.Image;
        return `${image.text} (${image.href})`;
      }
      case "br":
        return "\n";
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) return renderInline(token.tokens);
        return "text" in token && typeof token.text === "string" ? token.text : "";
    }
  }).join(""));
}

function wrapWithPrefix(prefix: string, value: string, width: number, indent: string): string[] {
  const firstPrefix = `${indent}${prefix}`;
  const continuation = " ".repeat(visibleWidth(firstPrefix));
  const wrapped = wrapText(value, Math.max(1, width - visibleWidth(firstPrefix)));
  return wrapped.map((line, index) => truncateToWidth(`${index === 0 ? firstPrefix : continuation}${line}`, width));
}

function allocateWidths(desired: readonly number[], available: number, minimum: number): number[] {
  const widths = desired.map(() => minimum);
  let remaining = Math.max(0, available - widths.length * minimum);
  while (remaining > 0) {
    const candidate = widths
      .map((value, index) => ({ index, need: Math.max(0, (desired[index] ?? minimum) - value) }))
      .sort((left, right) => right.need - left.need)[0];
    if (!candidate || candidate.need === 0) break;
    widths[candidate.index] = (widths[candidate.index] ?? minimum) + 1;
    remaining -= 1;
  }
  return widths;
}

function parseUnifiedDiff(lines: readonly string[]): DiffEntry[] {
  const entries: DiffEntry[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  for (const line of lines) {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/u.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      entries.push({ kind: "hunk", text: line });
    } else if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ")) {
      entries.push({ kind: "file", text: line });
    } else if (oldLine !== undefined && newLine !== undefined && line.startsWith("+")) {
      entries.push({ kind: "add", text: line.slice(1), newLine });
      newLine += 1;
    } else if (oldLine !== undefined && newLine !== undefined && line.startsWith("-")) {
      entries.push({ kind: "delete", text: line.slice(1), oldLine });
      oldLine += 1;
    } else if (oldLine !== undefined && newLine !== undefined) {
      entries.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      entries.push({ kind: "file", text: line });
    }
  }
  return entries;
}

function foldDiffContext(entries: readonly DiffEntry[], maxContextLines: number): DiffEntry[] {
  const output: DiffEntry[] = [];
  for (let index = 0; index < entries.length;) {
    if (entries[index]?.kind !== "context") {
      output.push(entries[index] as DiffEntry);
      index += 1;
      continue;
    }
    let end = index;
    while (entries[end]?.kind === "context") end += 1;
    const run = entries.slice(index, end);
    if (run.length > maxContextLines) {
      const edge = Math.max(1, Math.floor(maxContextLines / 2));
      output.push(...run.slice(0, edge));
      output.push({ kind: "fold", text: `... ${run.length - edge * 2} unchanged lines ...` });
      output.push(...run.slice(-edge));
    } else {
      output.push(...run);
    }
    index = end;
  }
  return output;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function normalizeEditorText(value: string): string {
  return sanitizeTerminalText(value);
}
