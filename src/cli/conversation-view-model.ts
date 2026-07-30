import { inspect } from "node:util";

import type { ApprovalDecision, ApprovalPrompt, ApprovalResponse } from "../approval/types.js";
import type { ToolCall, ToolResult } from "../core/messages.js";
import { redactText, redactValue } from "../redaction/redactor.js";
import { sanitizeTerminalText, truncateToWidth, visibleWidth, wrapText } from "@mingxu/tui";

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
    return this.#upsertBlock(id, "tool", {
      title: toolCall.name,
      state: "streaming",
      summary: this.#describeToolInput(toolCall.input),
      lines: [`input: ${this.#describeToolInput(toolCall.input)}`],
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
      summary: this.#describeToolSummary(toolCall.name, result),
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
    const blocks = this.#blocks.slice(-maxBlocks);
    if (blocks.length === 0) {
      return [...this.#emptyHint];
    }

    const lines: string[] = [];
    for (const block of blocks) {
      lines.push(this.#renderHeader(block, width));
      const body = this.#renderBody(block, width, detailed);
      if (body.length > 0) {
        lines.push(...body);
      }
      lines.push("");
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

  #describeToolSummary(name: string, result: ToolResult): string {
    const status = result.isError ? "error" : "done";
    const suffix = result.truncated ? " - truncated" : "";
    return `${name} - ${status}${suffix}`;
  }

  #renderHeader(block: ConversationBlock, width: number): string {
    const symbols: Record<ConversationBlockKind, string> = {
      user: "You",
      assistant: "MingXu",
      tool: "Tool",
      status: "Status",
      error: "Error",
      "approval-result": "Approval",
    };
    const prefix = symbols[block.kind];
    const title = block.kind === "assistant" ? "" : ` - ${block.title}`;
    const state = block.live ? " - streaming" : block.state === "error" ? " - error" : "";
    return truncateToWidth(`${prefix}${title}${state}`, width);
  }

  #renderBody(block: ConversationBlock, width: number, detailed: boolean): string[] {
    const bodyWidth = Math.max(1, width - 2);
    if (block.kind === "tool" && !detailed && block.state !== "error") {
      return block.summary ? [`  ${truncateToWidth(block.summary, bodyWidth)}`] : [];
    }

    if (block.kind === "status" && !detailed) {
      return block.lines.length > 0 ? [`  ${truncateToWidth(block.lines[0]!, bodyWidth)}`] : [];
    }

    const lines = block.lines.length > 0 ? block.lines : (block.summary ? [block.summary] : []);
    return lines.flatMap((line) => {
      const wrapped = wrapText(line, bodyWidth);
      return wrapped.map((wrappedLine) => `  ${truncateToWidth(wrappedLine, bodyWidth)}`);
    });
  }
}
