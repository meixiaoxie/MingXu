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
import { padToWidth, splitGraphemes, truncateToWidth, visibleWidth, wrapText } from "./strings.js";

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
    const title = this.#title?.trim() ?? "";
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
    const lines = this.#title ? [this.#title] : [];
    this.#items.forEach((item, index) => {
      const prefix = index === this.#selectedIndex ? ">" : " ";
      const base = `${prefix} ${item.label}`;
      lines.push(truncateToWidth(base, width));
      if (item.description) {
        lines.push(truncateToWidth(`  ${item.description}`, width));
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
    const lines: string[] = [];
    for (const rawLine of this.#text.split(/\r?\n/u)) {
      const line = rawLine
        .replace(/^###\s+/u, "  ")
        .replace(/^##\s+/u, "")
        .replace(/^#\s+/u, "")
        .replace(/^\s*-\s+/u, "- ");
      lines.push(...wrapText(line, width));
    }
    return lines;
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
        lines.push(truncateToWidth(`${prefix}${connector}${node.label}`, width));
        if (node.children?.length) {
          visit(node.children, `${prefix}${index === nodes.length - 1 ? "    " : "|   "}`);
        }
      });
    };
    visit(this.#nodes, "");
    return lines;
  }
}

export class Table implements Component {
  #rows: readonly (readonly string[])[] = [];

  constructor(rows: readonly (readonly string[])[] = []) {
    this.#rows = rows;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.#rows.map((row) => truncateToWidth(row.join(" | "), width));
  }
}

export class KeyValue implements Component {
  #entries: readonly (readonly [string, string])[] = [];

  constructor(entries: readonly (readonly [string, string])[] = []) {
    this.#entries = entries;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.#entries.map(([key, value]) => truncateToWidth(`${key}: ${value}`, width));
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
    const pct = Math.max(0, Math.min(100, Math.round((this.#current / this.#total) * 100)));
    const barWidth = Math.max(8, width - visibleWidth(this.#label) - 10);
    const filled = Math.round((barWidth * pct) / 100);
    const bar = `[${"=".repeat(filled)}${" ".repeat(Math.max(0, barWidth - filled))}]`;
    return [truncateToWidth(`${this.#label} ${bar} ${pct}%`, width)];
  }
}

export class Diff implements Component {
  #lines: readonly string[] = [];

  constructor(lines: readonly string[] = []) {
    this.#lines = lines;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.#lines.map((line) => truncateToWidth(line, width));
  }
}

function normalizeEditorText(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}
