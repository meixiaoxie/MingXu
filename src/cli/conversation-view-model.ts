import { inspect } from "node:util";

import type { ApprovalDecision, ApprovalPrompt, ApprovalResponse } from "../approval/types.js";
import type { ToolCall, ToolResult } from "../core/messages.js";
import type { SessionPresentationBlock } from "../session/types.js";
import { redactText, redactValue } from "../redaction/redactor.js";
import { sanitizeTerminalText, truncateToWidth, visibleWidth, wrapText } from "@mingxu/tui";
import { styleTranscript, type TranscriptTheme, type TranscriptTone } from "./transcript-theme.js";

export type ConversationBlockKind = "user" | "assistant" | "tool" | "status" | "error" | "approval-result";

export interface ConversationBlock {
  readonly id: string;
  readonly kind: ConversationBlockKind;
  title: string;
  state: "streaming" | "complete" | "error" | "collapsed";
  revision: number;
  summary: string;
  lines: string[];
  live?: boolean;
  source?: string;
}

export interface ConversationRenderOptions {
  readonly detailed?: boolean;
  readonly maxBlocks?: number;
  readonly theme?: TranscriptTheme;
}

export interface PreparedConversationRender {
  readonly lines: string[];
  readonly commitPrefixLineCount: number;
  commit(): void;
}

export class ConversationViewModel {
  readonly #blocks: ConversationBlock[] = [];
  readonly #blockIndex = new Map<string, ConversationBlock>();
  #emptyHint: readonly string[] = [];
  #committedBlockCount = 0;

  setEmptyHint(lines: readonly string[]): void {
    this.#emptyHint = lines.map((line) => sanitizeTerminalText(line));
  }

  clear(): void {
    this.#blocks.length = 0;
    this.#blockIndex.clear();
    this.#committedBlockCount = 0;
  }

  hasBlock(id: string): boolean {
    return this.#blockIndex.has(id);
  }

  getBlock(id: string): ConversationBlock | undefined {
    return this.#blockIndex.get(id);
  }

  pushUserMessage(id: string, text: string): ConversationBlock {
    return this.#upsertBlock(id, "user", {
      title: "you",
      state: "complete",
      summary: sanitizeTerminalText(text),
      lines: this.#messageLines(text),
      live: false,
    });
  }

  startAssistantMessage(id: string, title = "MingXu"): ConversationBlock {
    const existing = this.#blockIndex.get(id);
    if (existing?.kind === "assistant" && (existing.state === "complete" || existing.state === "error")) {
      return existing;
    }
    return this.#upsertBlock(id, "assistant", {
      title,
      state: "streaming",
      summary: "",
      lines: [],
      live: true,
    });
  }

  updateAssistantMessage(id: string, content: string): ConversationBlock {
    const sanitized = sanitizeTerminalText(content);
    const existing = this.#blockIndex.get(id);
    if (existing?.kind === "assistant" && (existing.state === "complete" || existing.state === "error")) {
      return existing;
    }
    if (existing && existing.kind === "assistant" && visibleWidth(sanitized) < visibleWidth(existing.summary)) {
      return existing;
    }
    return this.#upsertBlock(id, "assistant", {
      title: existing?.title ?? "MingXu",
      state: "streaming",
      summary: sanitized,
      lines: this.#messageLines(sanitized),
      live: true,
    });
  }

  finishAssistantMessage(id: string, content: string, title = "MingXu"): ConversationBlock | undefined {
    const existing = this.#blockIndex.get(id);
    if (!existing || existing.kind !== "assistant") {
      return undefined;
    }
    const sanitized = sanitizeTerminalText(content);
    const summary = visibleWidth(sanitized) < visibleWidth(existing.summary) ? existing.summary : sanitized;
    return this.#upsertBlock(id, "assistant", {
      title,
      state: "complete",
      summary,
      lines: this.#messageLines(summary),
      live: false,
    });
  }

  startToolMessage(id: string, toolCall: ToolCall, source?: string): ConversationBlock {
    const existing = this.#blockIndex.get(id);
    if (existing?.kind === "tool" && (existing.state === "complete" || existing.state === "error")) {
      return existing;
    }
    const input = this.#describeToolInput(toolCall.input);
    return this.#upsertBlock(id, "tool", {
      title: toolCall.name,
      state: "streaming",
      summary: input,
      lines: [`input: ${input}`],
      live: true,
      ...(source ? { source } : {}),
    });
  }

  updateToolMessage(id: string, partialResult: unknown): ConversationBlock | undefined {
    const block = this.#blockIndex.get(id);
    if (!block || block.kind !== "tool") {
      return undefined;
    }
    if (block.state === "complete" || block.state === "error") {
      return block;
    }
    return this.#upsertBlock(id, "tool", {
      title: block.title,
      state: "streaming",
      summary: block.summary,
      lines: [block.lines[0] ?? "", `preview: ${this.#describeValue(partialResult)}`],
      live: true,
      ...(block.source !== undefined ? { source: block.source } : {}),
    });
  }

  finishToolMessage(id: string, toolCall: ToolCall, result: ToolResult, source?: string): ConversationBlock | undefined {
    const existing = this.#blockIndex.get(id);
    if (!existing || existing.kind !== "tool") {
      return undefined;
    }
    const body = [
      `input: ${this.#describeToolInput(toolCall.input)}`,
      `output: ${this.#describeValue(result.output)}`,
      `status: ${result.isError ? "error" : "done"}`,
      ...(result.truncated ? ["output: truncated"] : []),
      ...(result.originalBytes !== undefined ? [`bytes: ${result.originalBytes}`] : []),
    ];
    if (result.artifact) {
      body.push(`artifact: ${result.artifact.mediaType} (${result.artifact.bytes} bytes)`);
    }
    return this.#upsertBlock(id, "tool", {
      title: toolCall.name,
      state: result.isError ? "error" : "complete",
      summary: this.#describeToolSummary(result),
      lines: body,
      live: false,
      ...(source ? { source } : {}),
    });
  }

  addStatus(id: string, title: string, lines: readonly string[]): ConversationBlock {
    return this.#upsertBlock(id, "status", {
      title,
      state: "complete",
      summary: lines[0] ?? title,
      lines: lines.map((line) => sanitizeTerminalText(line)),
      live: false,
    });
  }

  addError(id: string, title: string, error: string): ConversationBlock {
    return this.#upsertBlock(id, "error", {
      title,
      state: "error",
      summary: sanitizeTerminalText(error),
      lines: [redactText(error)],
      live: false,
    });
  }

  addApprovalResult(id: string, prompt: ApprovalPrompt, response: ApprovalResponse | undefined): ConversationBlock {
    const decision: ApprovalDecision = response?.decision ?? "deny";
    const scope = response?.scope ? ` (${response.scope})` : "";
    return this.#upsertBlock(id, "approval-result", {
      title: `${prompt.toolName} approval`,
      state: "complete",
      summary: `${decision}${scope}`,
      lines: [
        `tool: ${prompt.toolName}`,
        `decision: ${decision}${scope}`,
        `principal: ${prompt.principalId}`,
        `action: ${prompt.actionKind}`,
        `resource: ${prompt.resourceScope}`,
        `policy: ${prompt.policyEffect}`,
      ],
      live: false,
    });
  }

  render(width: number, options: ConversationRenderOptions = {}): string[] {
    if (this.#blocks.length === 0) {
      return [...this.#emptyHint];
    }
    const startIndex = Math.max(0, this.#blocks.length - (options.maxBlocks ?? Number.POSITIVE_INFINITY));
    return flattenRenderedBlocks(this.#renderBlockGroups(startIndex, width, options)).lines;
  }

  prepareRender(
    width: number,
    options: ConversationRenderOptions = {},
    frameOptions: { readonly full: boolean },
  ): PreparedConversationRender {
    if (this.#blocks.length === 0) {
      return { lines: [...this.#emptyHint], commitPrefixLineCount: 0, commit: () => undefined };
    }

    let commitTarget = this.#committedBlockCount;
    while (commitTarget < this.#blocks.length && isCommittable(this.#blocks[commitTarget])) {
      commitTarget += 1;
    }

    const requestedStart = frameOptions.full ? 0 : this.#committedBlockCount;
    const startIndex = Math.max(
      requestedStart,
      this.#blocks.length - (options.maxBlocks ?? Number.POSITIVE_INFINITY),
    );
    const flattened = flattenRenderedBlocks(this.#renderBlockGroups(startIndex, width, options), commitTarget);
    let committed = false;
    return {
      lines: flattened.lines,
      commitPrefixLineCount: flattened.commitPrefixLineCount,
      commit: () => {
        if (committed) return;
        committed = true;
        this.#committedBlockCount = Math.max(this.#committedBlockCount, commitTarget);
      },
    };
  }

  get blocks(): readonly ConversationBlock[] {
    return this.#blocks;
  }

  get committedBlockCount(): number {
    return this.#committedBlockCount;
  }

  get activeBlockCount(): number {
    return this.#blocks.length - this.#committedBlockCount;
  }

  applyPresentationBlock(block: SessionPresentationBlock): boolean {
    const existing = this.#blockIndex.get(block.id);
    if (existing && (existing.kind !== block.kind || existing.revision >= block.revision)) {
      return false;
    }
    const normalized: ConversationBlock = {
      id: sanitizeTerminalText(block.id),
      kind: block.kind,
      revision: block.revision,
      title: sanitizeTerminalText(block.title),
      state: block.state,
      summary: sanitizeTerminalText(block.summary),
      lines: block.lines.map((line) => sanitizeTerminalText(line)),
      ...(block.live !== undefined ? { live: block.live } : {}),
      ...(block.source !== undefined ? { source: sanitizeTerminalText(block.source) } : {}),
    };
    if (existing) {
      Object.assign(existing, normalized);
      return true;
    }
    this.#blocks.push(normalized);
    this.#blockIndex.set(normalized.id, normalized);
    return true;
  }

  presentationBlocks(): SessionPresentationBlock[] {
    return this.#blocks.map((block) => ({
      id: block.id,
      revision: block.revision,
      kind: block.kind,
      title: block.title,
      state: block.state,
      summary: block.summary,
      lines: [...block.lines],
      ...(block.live !== undefined ? { live: block.live } : {}),
      ...(block.source !== undefined ? { source: block.source } : {}),
    }));
  }

  #upsertBlock(
    id: string,
    kind: ConversationBlockKind,
    patch: Omit<ConversationBlock, "id" | "kind" | "revision">,
  ): ConversationBlock {
    const existing = this.#blockIndex.get(id);
    if (existing) {
      if (existing.kind !== kind) {
        Object.assign(existing, patch);
        existing.revision += 1;
        return existing;
      }
      if (sameConversationPatch(existing, patch)) {
        return existing;
      }
      Object.assign(existing, patch);
      existing.revision += 1;
      return existing;
    }
    const block: ConversationBlock = {
      id,
      kind,
      revision: 1,
      ...patch,
    };
    this.#blocks.push(block);
    this.#blockIndex.set(id, block);
    return block;
  }

  #renderBlockGroups(
    startIndex: number,
    width: number,
    options: ConversationRenderOptions,
  ): RenderedBlockGroup[] {
    const detailed = options.detailed === true;
    const groups: RenderedBlockGroup[] = [];
    for (let index = startIndex; index < this.#blocks.length; index += 1) {
      const block = this.#blocks[index];
      if (!block) continue;
      const lines = detailed
        ? this.#renderDetailedBlock(block, width, options.theme)
        : this.#renderCompactOrDetailedBlock(block, width, options.theme);
      if (lines.length > 0) groups.push({ blockIndex: index, lines });
    }
    return groups;
  }

  #messageLines(text: string): string[] {
    const sanitized = sanitizeTerminalText(text);
    if (!sanitized) {
      return [];
    }
    return sanitized.split(/\r?\n/u);
  }

  #describeToolInput(value: unknown): string {
    if (typeof value === "string") {
      return sanitizeTerminalText(value);
    }
    return this.#describeValue(value);
  }

  #describeValue(value: unknown): string {
    try {
      return sanitizeTerminalText(inspect(redactValue(value), { depth: 4, breakLength: 100 }));
    } catch {
      return sanitizeTerminalText(String(value));
    }
  }

  #describeToolSummary(result: ToolResult): string {
    const status = result.isError ? "error" : "done";
    const suffix = result.truncated ? " - truncated" : "";
    return `${status}${suffix}`;
  }

  #renderCompactOrDetailedBlock(block: ConversationBlock, width: number, theme: TranscriptTheme | undefined): string[] {
    if (block.kind === "status" && block.title === "run") {
      return [];
    }
    if (block.kind === "user" || block.kind === "assistant") {
      return this.#renderDetailedBlock(block, width, theme);
    }
    const text = this.#compactText(block);
    return [this.#styleLine(this.#prefix(block, text, width), theme, this.#toneForBlock(block), width)];
  }

  #renderDetailedBlock(block: ConversationBlock, width: number, theme: TranscriptTheme | undefined): string[] {
    const header = this.#styleLine(this.#prefix(block, this.#headerText(block), width), theme, this.#toneForBlock(block), width);
    const bodyWidth = Math.max(1, width - 2);
    const bodySource = block.lines.length > 0 ? block.lines : (block.summary ? [block.summary] : []);
    const body = bodySource.flatMap((line) => {
      const wrapped = wrapText(line, bodyWidth);
      return wrapped.map((wrappedLine) => this.#styleLine(`  ${truncateToWidth(wrappedLine, bodyWidth)}`, theme, this.#toneForBlock(block), bodyWidth));
    });
    return body.length > 0 ? [header, ...body] : [header];
  }

  #compactText(block: ConversationBlock): string {
    if (block.kind === "status" && block.title === "run") {
      return "";
    }
    if (block.summary) {
      return `${block.title}: ${block.summary}`;
    }
    return block.title;
  }

  #headerText(block: ConversationBlock): string {
    switch (block.kind) {
      case "user":
        return block.title;
      case "assistant":
        return block.title;
      case "tool":
        return block.live ? `${block.title} (running)` : block.state === "error" ? `${block.title} (error)` : `${block.title} (done)`;
      case "status":
        return block.title;
      case "error":
        return block.title;
      case "approval-result":
        return block.title;
    }
  }

  #prefix(block: ConversationBlock, text: string, width: number): string {
    const symbol = this.#symbolForBlock(block);
    return truncateToWidth(`${symbol} ${text}`.trim(), width);
  }

  #symbolForBlock(block: ConversationBlock): string {
    switch (block.kind) {
      case "user":
        return ">";
      case "assistant":
        return "~";
      case "tool":
        if (block.state === "streaming") return "*";
        if (block.state === "error") return "!";
        return "+";
      case "status":
        return "-";
      case "error":
        return "!";
      case "approval-result":
        return "?";
    }
  }

  #styleLine(line: string, theme: TranscriptTheme | undefined, tone: TranscriptTone, width?: number): string {
    const plain = width !== undefined ? truncateToWidth(line, width) : line;
    if (!theme) {
      return plain;
    }
    return styleTranscript(theme, tone, plain);
  }

  #toneForBlock(block: ConversationBlock): TranscriptTone {
    switch (block.kind) {
      case "user":
        return "user";
      case "assistant":
        return "assistant";
      case "tool":
        return block.state === "error" ? "error" : "tool";
      case "status":
        return "status";
      case "error":
        return "error";
      case "approval-result":
        return "accent";
    }
  }
}

interface RenderedBlockGroup {
  readonly blockIndex: number;
  readonly lines: readonly string[];
}

function flattenRenderedBlocks(
  groups: readonly RenderedBlockGroup[],
  commitTarget = 0,
): { readonly lines: string[]; readonly commitPrefixLineCount: number } {
  const lines: string[] = [];
  let commitPrefixLineCount = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group) continue;
    lines.push(...group.lines);
    const nextGroup = groups[index + 1];
    if (nextGroup) lines.push("");
    if (group.blockIndex < commitTarget) {
      commitPrefixLineCount = lines.length;
    }
  }
  return { lines, commitPrefixLineCount };
}

function isCommittable(block: ConversationBlock | undefined): boolean {
  return block !== undefined && block.state !== "streaming" && block.live !== true;
}

function sameConversationPatch(
  block: ConversationBlock,
  patch: Omit<ConversationBlock, "id" | "kind" | "revision">,
): boolean {
  return block.title === patch.title
    && block.state === patch.state
    && block.summary === patch.summary
    && block.live === patch.live
    && block.source === patch.source
    && sameLines(block.lines, patch.lines);
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((line, index) => line === right[index]);
}
