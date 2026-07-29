import type { AgentMessage, AgentState, ToolCall, ToolResult } from "../core/messages.js";

export type { AgentMessage, AgentState, ToolCall, ToolResult } from "../core/messages.js";

export type RuntimeEventSource = "core" | "model" | "tool" | "plugin" | "memory" | "audit" | "cli";

export interface RuntimeEventContext {
  runId: string;
  sequence: number;
  source: RuntimeEventSource;
  sessionId?: string;
  traceId?: string;
}

export interface RuntimeEventMap {
  "instruction.discover": Record<string, unknown>;
  "instruction.load.start": Record<string, unknown>;
  "instruction.load.end": Record<string, unknown>;
  "instruction.load.error": Record<string, unknown>;
  "resource.discover": Record<string, unknown>;
  "resource.load.start": Record<string, unknown>;
  "resource.load.end": Record<string, unknown>;
  "resource.load.error": Record<string, unknown>;
  "memory.discover": Record<string, unknown>;
  "memory.query.start": Record<string, unknown>;
  "memory.query.end": Record<string, unknown>;
  "memory.query.error": Record<string, unknown>;
  "memory.save.start": Record<string, unknown>;
  "memory.save.end": Record<string, unknown>;
  "memory.save.error": Record<string, unknown>;
  "memory.delete.start": Record<string, unknown>;
  "memory.delete.end": Record<string, unknown>;
  "memory.delete.error": Record<string, unknown>;
  "skill.discover": Record<string, unknown>;
  "skill.load.start": Record<string, unknown>;
  "skill.load.end": Record<string, unknown>;
  "skill.load.error": Record<string, unknown>;
  "preset.discover": Record<string, unknown>;
  "preset.load.start": Record<string, unknown>;
  "preset.load.end": Record<string, unknown>;
  "preset.load.error": Record<string, unknown>;
  "mcp.connect.start": Record<string, unknown>;
  "mcp.connect.end": Record<string, unknown>;
  "mcp.connect.error": Record<string, unknown>;
  "mcp.tool.register": Record<string, unknown>;
  "mcp.tool.call.start": Record<string, unknown>;
  "mcp.tool.call.end": Record<string, unknown>;
  "mcp.tool.call.error": Record<string, unknown>;
  "mcp.resource.register": Record<string, unknown>;
  "mcp.resource.read.start": Record<string, unknown>;
  "mcp.resource.read.end": Record<string, unknown>;
  "mcp.resource.read.error": Record<string, unknown>;
  "mcp.prompt.register": Record<string, unknown>;
  "mcp.prompt.get.start": Record<string, unknown>;
  "mcp.prompt.get.end": Record<string, unknown>;
  "mcp.prompt.get.error": Record<string, unknown>;
  "subagent.spawn.start": Record<string, unknown>;
  "subagent.spawn.end": Record<string, unknown>;
  "subagent.spawn.error": Record<string, unknown>;
  "budget.exceeded": Record<string, unknown>;
  "run.start": Record<string, unknown>;
  "run.end": Record<string, unknown>;
  "run.error": Record<string, unknown>;
  "model.request.start": Record<string, unknown>;
  "model.request.end": Record<string, unknown>;
  "session.write.start": Record<string, unknown>;
  "session.write.end": Record<string, unknown>;
  "policy.decision": Record<string, unknown>;
  "approval.missing": Record<string, unknown>;
  "approval.matched": Record<string, unknown>;
  "tool.execution_blocked": Record<string, unknown>;
  "tool.execution_allowed": Record<string, unknown>;
  "tool.call.start": Record<string, unknown>;
  "tool.call.end": Record<string, unknown>;
  "tool.call.error": Record<string, unknown>;
  "plugin.load.start": Record<string, unknown>;
  "plugin.load.end": Record<string, unknown>;
  "plugin.load.error": Record<string, unknown>;
}

export type RuntimeEventType = keyof RuntimeEventMap;

export interface RuntimeEventEnvelope<
  TEventType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  version: "2026-07-29";
  eventId: string;
  eventType: TEventType;
  occurredAt: string;
  sequence: number;
  runId: string;
  sessionId?: string;
  traceId?: string;
  source: RuntimeEventSource;
  payload: TPayload;
}

export type RuntimeEvent = {
  [K in RuntimeEventType]: RuntimeEventEnvelope<K, RuntimeEventMap[K]>;
}[RuntimeEventType];

export interface AgentLifecycleEventMap {
  agent_start: { state: AgentState };
  turn_start: { turnId: string; input?: AgentMessage };
  message_start: { message: AgentMessage };
  message_update: { message: AgentMessage; delta?: unknown };
  message_end: { message: AgentMessage };
  tool_execution_start: { toolCall: ToolCall };
  tool_execution_update: { toolCall: ToolCall; partialResult: unknown };
  tool_execution_end: { toolCall: ToolCall; result: ToolResult };
  turn_end: { message: AgentMessage; toolResults: ToolResult[] };
  agent_end: { state: AgentState };
  error: { error: string; state: AgentState };
}

export type AgentLifecycleEventType = keyof AgentLifecycleEventMap;

export type AgentLifecycleEvent = {
  [K in AgentLifecycleEventType]: { type: K } & AgentLifecycleEventMap[K];
}[AgentLifecycleEventType];

export type AgentEvent = AgentLifecycleEvent;
export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;
export type AgentEventSink = AgentEventListener;

import { randomUUID } from "node:crypto";

export function createRuntimeEvent<TEventType extends RuntimeEventType>(
  eventType: TEventType,
  payload: RuntimeEventMap[TEventType],
  context: RuntimeEventContext,
): RuntimeEventEnvelope<TEventType, RuntimeEventMap[TEventType]> {
  return {
    version: "2026-07-29",
    eventId: randomUUID(),
    eventType,
    occurredAt: new Date().toISOString(),
    sequence: context.sequence,
    runId: context.runId,
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context.traceId !== undefined ? { traceId: context.traceId } : {}),
    source: context.source,
    payload,
  };
}
