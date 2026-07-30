import type { ApprovalPrompt, ApprovalResponse } from "../approval/types.js";
import type { ToolResult } from "../core/messages.js";
import type { AgentEvent } from "../events/types.js";
import { ConversationViewModel, type ConversationRenderOptions } from "./conversation-view-model.js";

interface ProjectionState {
  running: boolean;
  lastStatus: string;
}

export interface ProjectionResult {
  changed: boolean;
  appliedEvents: AgentEvent[];
}

export class CliRuntimeProjection {
  readonly conversation = new ConversationViewModel();
  readonly state: ProjectionState = {
    running: false,
    lastStatus: "Idle",
  };

  #appliedEventIds = new Set<string>();
  #pendingEventIds = new Set<string>();
  #lastSequences = new Map<string, number>();
  #pendingMessageEvents = new Map<string, AgentEvent[]>();
  #pendingToolEvents = new Map<string, AgentEvent[]>();

  clear(): void {
    this.conversation.clear();
    this.state.running = false;
    this.state.lastStatus = "Idle";
    this.#appliedEventIds.clear();
    this.#pendingEventIds.clear();
    this.#lastSequences.clear();
    this.#pendingMessageEvents.clear();
    this.#pendingToolEvents.clear();
  }

  setEmptyHint(lines: readonly string[]): void {
    this.conversation.setEmptyHint(lines);
  }

  setRunning(value: boolean): void {
    this.state.running = value;
  }

  setLastStatus(message: string): void {
    this.state.lastStatus = message;
  }

  pushUserMessage(id: string, text: string): void {
    this.conversation.pushUserMessage(id, text);
  }

  startAssistantMessage(id: string, title = "MingXu"): void {
    this.conversation.startAssistantMessage(id, title);
  }

  updateAssistantMessage(id: string, content: string): void {
    this.conversation.updateAssistantMessage(id, content);
  }

  finishAssistantMessage(id: string, content: string, title = "MingXu"): void {
    this.conversation.finishAssistantMessage(id, content, title);
  }

  startToolMessage(id: string, toolCall: { id: string; name: string; input: unknown }, source?: string): void {
    this.conversation.startToolMessage(id, toolCall, source);
  }

  updateToolMessage(id: string, partialResult: unknown): void {
    this.conversation.updateToolMessage(id, partialResult);
  }

  finishToolMessage(
    id: string,
    toolCall: { id: string; name: string; input: unknown },
    result: ToolResult,
    source?: string,
  ): void {
    this.conversation.finishToolMessage(id, toolCall, result, source);
  }

  addStatus(id: string, title: string, lines: readonly string[]): void {
    this.state.lastStatus = lines[0] ?? title;
    this.conversation.addStatus(id, title, lines);
  }

  addError(id: string, title: string, error: unknown): void {
    this.state.running = false;
    const message = normalizeErrorText(error);
    this.state.lastStatus = `Error: ${message}`;
    this.conversation.addError(id, title, message);
  }

  addApprovalResult(id: string, prompt: ApprovalPrompt, response: ApprovalResponse | undefined): void {
    this.conversation.addApprovalResult(id, prompt, response);
  }

  render(width: number, options: ConversationRenderOptions = {}): string[] {
    return this.conversation.render(width, options);
  }

  get blocks() {
    return this.conversation.blocks;
  }

  getBlock(id: string) {
    return this.conversation.getBlock(id);
  }

  hasBlock(id: string): boolean {
    return this.conversation.hasBlock(id);
  }

  applyAgentEvent(event: AgentEvent): ProjectionResult {
    const result = createProjectionResult();
    const eventId = event.eventId;
    if (eventId !== undefined) {
      if (this.#appliedEventIds.has(eventId) || this.#pendingEventIds.has(eventId)) {
        return result;
      }
    }
    const targetKey = getEventTargetKey(event);
    if (targetKey !== undefined && event.sequence !== undefined) {
      const lastSequence = this.#lastSequences.get(targetKey);
      if (lastSequence !== undefined && event.sequence <= lastSequence) {
        this.#markIgnored(event);
        return result;
      }
    }

    switch (event.type) {
      case "agent_start":
        this.#markApplied(event, result);
        this.state.running = true;
        this.state.lastStatus = "Run started";
        result.changed = true;
        return result;
      case "turn_start":
        this.#markApplied(event, result);
        return result;
      case "message_start":
        if (event.message.role === "assistant") {
          const before = this.getBlock(event.message.id)?.revision ?? 0;
          this.conversation.startAssistantMessage(event.message.id, "MingXu");
          this.#markApplied(event, result, (this.getBlock(event.message.id)?.revision ?? 0) !== before);
          return mergeProjectionResults(result, this.#flushPendingMessageEvents(event.message.id));
        }
        if (event.message.role === "user") {
          const before = this.getBlock(event.message.id)?.revision ?? 0;
          this.conversation.pushUserMessage(event.message.id, event.message.content);
          this.#markApplied(event, result, (this.getBlock(event.message.id)?.revision ?? 0) !== before);
          return result;
        }
        return result;
      case "message_update": {
        const messageId = event.message.id;
        if (!this.hasBlock(messageId)) {
          this.#queuePendingMessageEvent(messageId, event);
          return result;
        }
        const before = this.getBlock(messageId)?.revision ?? 0;
        this.conversation.updateAssistantMessage(messageId, event.message.content);
        this.#markApplied(event, result, (this.getBlock(messageId)?.revision ?? 0) !== before);
        return result;
      }
      case "message_end": {
        const messageId = event.message.id;
        if (!this.hasBlock(messageId)) {
          this.#queuePendingMessageEvent(messageId, event);
          return result;
        }
        const before = this.getBlock(messageId)?.revision ?? 0;
        this.conversation.finishAssistantMessage(messageId, event.message.content, "MingXu");
        this.#markApplied(event, result, (this.getBlock(messageId)?.revision ?? 0) !== before);
        return result;
      }
      case "tool_execution_start": {
        const before = this.getBlock(event.toolCall.id)?.revision ?? 0;
        this.conversation.startToolMessage(event.toolCall.id, event.toolCall);
        this.#markApplied(event, result, (this.getBlock(event.toolCall.id)?.revision ?? 0) !== before);
        return mergeProjectionResults(result, this.#flushPendingToolEvents(event.toolCall.id));
      }
      case "tool_execution_update": {
        if (!this.hasBlock(event.toolCall.id)) {
          this.#queuePendingToolEvent(event.toolCall.id, event);
          return result;
        }
        const before = this.getBlock(event.toolCall.id)?.revision ?? 0;
        this.conversation.updateToolMessage(event.toolCall.id, event.partialResult);
        this.#markApplied(event, result, (this.getBlock(event.toolCall.id)?.revision ?? 0) !== before);
        return result;
      }
      case "tool_execution_end": {
        if (!this.hasBlock(event.toolCall.id)) {
          this.#queuePendingToolEvent(event.toolCall.id, event);
          return result;
        }
        const before = this.getBlock(event.toolCall.id)?.revision ?? 0;
        this.conversation.finishToolMessage(event.toolCall.id, event.toolCall, event.result);
        this.#markApplied(event, result, (this.getBlock(event.toolCall.id)?.revision ?? 0) !== before);
        return result;
      }
      case "turn_end":
        this.#markApplied(event, result);
        this.state.running = false;
        result.changed = true;
        return result;
      case "agent_end":
        this.#markApplied(event, result);
        this.state.running = false;
        result.changed = true;
        return mergeProjectionResults(result, this.#flushPendingDiagnostics());
      case "error":
        this.#markApplied(event, result, true);
        this.state.running = false;
        const message = normalizeErrorText(event.error);
        this.conversation.addError("agent-error", "agent error", message);
        this.state.lastStatus = `Error: ${message}`;
        result.changed = true;
        return result;
    }
  }

  #queuePendingMessageEvent(messageId: string, event: AgentEvent): void {
    const pending = this.#pendingMessageEvents.get(messageId) ?? [];
    if (event.eventId !== undefined && this.#pendingEventIds.has(event.eventId)) {
      return;
    }
    pending.push(event);
    this.#pendingMessageEvents.set(messageId, pending);
    if (event.eventId !== undefined) {
      this.#pendingEventIds.add(event.eventId);
    }
  }

  #queuePendingToolEvent(toolCallId: string, event: AgentEvent): void {
    const pending = this.#pendingToolEvents.get(toolCallId) ?? [];
    if (event.eventId !== undefined && this.#pendingEventIds.has(event.eventId)) {
      return;
    }
    pending.push(event);
    this.#pendingToolEvents.set(toolCallId, pending);
    if (event.eventId !== undefined) {
      this.#pendingEventIds.add(event.eventId);
    }
  }

  #flushPendingMessageEvents(messageId: string): ProjectionResult {
    const result = createProjectionResult();
    const pending = this.#pendingMessageEvents.get(messageId);
    if (!pending || pending.length === 0) {
      return result;
    }
    this.#pendingMessageEvents.delete(messageId);
    pending.sort(compareAgentEvents);
    for (const event of pending) {
      if (event.eventId !== undefined) {
        this.#pendingEventIds.delete(event.eventId);
      }
      mergeProjectionResults(result, this.applyAgentEvent(event));
    }
    return result;
  }

  #flushPendingToolEvents(toolCallId: string): ProjectionResult {
    const result = createProjectionResult();
    const pending = this.#pendingToolEvents.get(toolCallId);
    if (!pending || pending.length === 0) {
      return result;
    }
    this.#pendingToolEvents.delete(toolCallId);
    pending.sort(compareAgentEvents);
    for (const event of pending) {
      if (event.eventId !== undefined) {
        this.#pendingEventIds.delete(event.eventId);
      }
      mergeProjectionResults(result, this.applyAgentEvent(event));
    }
    return result;
  }

  #flushPendingDiagnostics(): ProjectionResult {
    const result = createProjectionResult();
    const pendingMessages = [...this.#pendingMessageEvents.keys()];
    const pendingTools = [...this.#pendingToolEvents.keys()];
    if (pendingMessages.length === 0 && pendingTools.length === 0) {
      return result;
    }
    const details = [
      ...(pendingMessages.length > 0 ? [`message events: ${pendingMessages.join(", ")}`] : []),
      ...(pendingTools.length > 0 ? [`tool events: ${pendingTools.join(", ")}`] : []),
    ];
    this.conversation.addError("projection-diagnostics", "projection", [
      "Dropped out-of-order events that never recovered.",
      ...details,
    ].join(" "));
    this.#pendingMessageEvents.clear();
    this.#pendingToolEvents.clear();
    this.#pendingEventIds.clear();
    result.changed = true;
    return result;
  }

  #markApplied(event: AgentEvent, result: ProjectionResult, changed = false): void {
    const eventId = event.eventId;
    if (eventId !== undefined) {
      this.#appliedEventIds.add(eventId);
    }
    const targetKey = getEventTargetKey(event);
    if (targetKey !== undefined && event.sequence !== undefined) {
      this.#lastSequences.set(targetKey, event.sequence);
    }
    if (changed) {
      result.appliedEvents.push(event);
      result.changed = true;
    }
  }

  #markIgnored(event: AgentEvent): void {
    if (event.eventId !== undefined) {
      this.#appliedEventIds.add(event.eventId);
    }
  }
}

function getEventTargetKey(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "message_start":
    case "message_update":
    case "message_end":
      return `message:${event.message.id}`;
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return `tool:${event.toolCall.id}`;
    default:
      return undefined;
  }
}

function compareAgentEvents(left: AgentEvent, right: AgentEvent): number {
  if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  if (left.eventId !== undefined && right.eventId !== undefined && left.eventId !== right.eventId) {
    return left.eventId.localeCompare(right.eventId);
  }
  return 0;
}

function createProjectionResult(): ProjectionResult {
  return {
    changed: false,
    appliedEvents: [],
  };
}

function normalizeErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}

function mergeProjectionResults(left: ProjectionResult, right: ProjectionResult): ProjectionResult {
  if (right.changed) {
    left.changed = true;
  }
  if (right.appliedEvents.length > 0) {
    left.appliedEvents.push(...right.appliedEvents);
    left.changed = true;
  }
  return left;
}
