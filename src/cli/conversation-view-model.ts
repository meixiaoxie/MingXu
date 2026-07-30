import { inspect } from "node:util";

import type { ApprovalDecision, ApprovalPrompt, ApprovalResponse } from "../approval/types.js";
import type { ToolCall, ToolResult } from "../core/messages.js";
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

export class ConversationViewModel {
  readonly #blocks: ConversationBlock[] = [];
  readonly #blockIndex = new Map<string, ConversationBlock>();
  #emptyHint: readonly string[] = [];

  setEmptyHint(lines: readonly string[]): void {
    this.#emptyHint = lines.map((line) => sanitizeTerminalText(line));
  }

  clear(): void {
    this.#blocks.length = 0;
    this.#blockIndex.clear();
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

  finishAssistantMessage(id: string, content: string, title = "MingXu"): ConversationBlock {
    const sanitized = sanitizeTerminalText(content);
    return this.#upsertBlock(id, "assistant", {
      title,
      state: "complete",
      summary: sanitized,
      lines: this.#messageLines(sanitized),
      live: false,
    });
  }

  startToolMessage(id: string, toolCall: ToolCall, source?: string): ConversationBlock {
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
    return this.#upsertBlock(id, "tool", {
      title: block.title,
      state: "streaming",
      summary: block.summary,
      lines: [block.lines[0] ?? "", `preview: ${this.#describeValue(partialResult)}`],
      live: true,
      ...(block.source !== undefined ? { source: block.source } : {}),
    });
  }

  finishToolMessage(id: string, toolCall: ToolCall, result: ToolResult, source?: string): ConversationBlock {
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
    const detailed = options.detailed === true;
    const maxBlocks = options.maxBlocks ?? 999;
    const theme = options.theme;
    const blocks = this.#blocks.slice(-maxBlocks);
    if (blocks.length === 0) {
      return [...this.#emptyHint];
    }

    const lines: string[] = [];
    for (const block of blocks) {
      const rendered = detailed
        ? this.#renderDetailedBlock(block, width, theme)
        : this.#renderCompactOrDetailedBlock(block, width, theme);
      if (rendered.length === 0) {
        continue;
      }
      lines.push(...rendered, "");
    }
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  }

  get blocks(): readonly ConversationBlock[] {
    return this.#blocks;
  }

  #upsertBlock(
    id: string,
    kind: ConversationBlockKind,
    patch: Omit<ConversationBlock, "id" | "kind" | "revision">,
  ): ConversationBlock {
    const existing = this.#blockIndex.get(id);
    if (existing) {
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
