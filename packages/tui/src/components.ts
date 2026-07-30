import { CURSOR_MARKER, type Component, type ComponentAction, type KeyInput } from "./types.js";
import { padToWidth, truncateToWidth, visibleWidth, wrapText } from "./strings.js";

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

export class Editor implements Component {
  readonly #prompt: string;
  readonly #placeholder: string;
  readonly #completionProvider: ((value: string) => readonly SelectListItem[]) | undefined;
  readonly #history: string[];
  #value = "";
  #cursor = 0;
  #historyIndex: number | undefined;
  #completionItems: readonly SelectListItem[] = [];
  #completionIndex = 0;
  #menuVisible = false;

  constructor(options: EditorOptions = {}) {
    this.#prompt = options.prompt ?? "> ";
    this.#placeholder = options.placeholder ?? "";
    this.#completionProvider = options.completionProvider;
    this.#history = [...(options.history ?? [])];
  }

  get value(): string {
    return this.#value;
  }

  clear(): void {
    this.#value = "";
    this.#cursor = 0;
    this.#historyIndex = undefined;
    this.#menuVisible = false;
    this.#completionItems = [];
    this.#completionIndex = 0;
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
    if (input.ctrl && input.name === "c") {
      return { type: "cancel" };
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

    if (input.name === "backspace") {
      this.#deleteBackward();
      return { type: "none" };
    }

    if (input.name === "delete") {
      this.#deleteForward();
      return { type: "none" };
    }

    if (input.name === "left") {
      this.#cursor = Math.max(0, this.#cursor - 1);
      return { type: "none" };
    }

    if (input.name === "right") {
      this.#cursor = Math.min(this.#value.length, this.#cursor + 1);
      return { type: "none" };
    }

    if (input.name === "home" || (input.ctrl && input.name === "a")) {
      this.#cursor = 0;
      return { type: "none" };
    }

    if (input.name === "end" || (input.ctrl && input.name === "e")) {
      this.#cursor = this.#value.length;
      return { type: "none" };
    }

    if (input.name === "up") {
      if (this.#menuVisible && this.#completionItems.length > 0) {
        this.#completionIndex = (this.#completionIndex - 1 + this.#completionItems.length) % this.#completionItems.length;
      } else {
        this.#historyUp();
      }
      return { type: "none" };
    }

    if (input.name === "down") {
      if (this.#menuVisible && this.#completionItems.length > 0) {
        this.#completionIndex = (this.#completionIndex + 1) % this.#completionItems.length;
      } else {
        this.#historyDown();
      }
      return { type: "none" };
    }

    if (input.name === "escape") {
      if (this.#menuVisible) {
        this.#menuVisible = false;
        return { type: "none" };
      }
      this.clear();
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

  render(width: number): string[] {
    const inputLine = `${this.#prompt}${this.#value || this.#placeholder}`;
    const lines = this.#value.length > 0
      ? splitWithCursor(inputLine, this.#prompt.length + this.#cursor)
      : [inputLine];

    const completionProvider = this.#completionProvider;
    if (completionProvider && this.#value.trim().startsWith("/")) {
      this.#completionItems = completionProvider(this.#value.trim());
      this.#menuVisible = this.#completionItems.length > 0;
      if (this.#completionIndex >= this.#completionItems.length) {
        this.#completionIndex = 0;
      }
    } else {
      this.#menuVisible = false;
      this.#completionItems = [];
      this.#completionIndex = 0;
    }

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
    this.#value = `${this.#value.slice(0, this.#cursor)}${text}${this.#value.slice(this.#cursor)}`;
    this.#cursor += text.length;
    this.#historyIndex = undefined;
  }

  #deleteBackward(): void {
    if (this.#cursor === 0) {
      return;
    }
    this.#value = `${this.#value.slice(0, this.#cursor - 1)}${this.#value.slice(this.#cursor)}`;
    this.#cursor -= 1;
    this.#historyIndex = undefined;
  }

  #deleteForward(): void {
    if (this.#cursor >= this.#value.length) {
      return;
    }
    this.#value = `${this.#value.slice(0, this.#cursor)}${this.#value.slice(this.#cursor + 1)}`;
    this.#historyIndex = undefined;
  }

  #historyUp(): void {
    if (this.#history.length === 0) {
      return;
    }
    const nextIndex = this.#historyIndex === undefined ? this.#history.length - 1 : Math.max(0, this.#historyIndex - 1);
    this.#historyIndex = nextIndex;
    this.#value = this.#history[nextIndex] ?? "";
    this.#cursor = this.#value.length;
  }

  #historyDown(): void {
    if (this.#history.length === 0 || this.#historyIndex === undefined) {
      return;
    }
    if (this.#historyIndex >= this.#history.length - 1) {
      this.#historyIndex = undefined;
      this.#value = "";
      this.#cursor = 0;
      return;
    }
    this.#historyIndex += 1;
    this.#value = this.#history[this.#historyIndex] ?? "";
    this.#cursor = this.#value.length;
  }

  #applyCompletion(item: SelectListItem): void {
    const current = this.#value.slice(0, this.#cursor);
    const prefixMatch = current.match(/(?:^|\s)\/[^\s]*/u);
    if (!prefixMatch) {
      return;
    }
    const start = current.length - prefixMatch[0].length;
    const before = this.#value.slice(0, start);
    const after = this.#value.slice(this.#cursor);
    this.#value = `${before}/${item.id}${after.startsWith(" ") ? "" : " "}${after}`;
    this.#cursor = before.length + item.id.length + 2;
    this.#menuVisible = false;
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

function splitWithCursor(value: string, cursorIndex: number): string[] {
  const before = value.slice(0, cursorIndex);
  const after = value.slice(cursorIndex);
  return [`${before}${CURSOR_MARKER}${after}`];
}
