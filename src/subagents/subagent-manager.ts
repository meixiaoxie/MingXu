import { randomUUID } from "node:crypto";

import type { AgentSession } from "../core/agent-session.js";
import type { AgentLoopResult } from "../core/types.js";
import type { AgentPresetRegistry, AgentPresetV1 } from "../presets/agent-preset-registry.js";
import { assertSafeIdentifier } from "../safety/path-safety.js";

export interface SubagentSpawnRequest {
  readonly prompt: string;
  readonly presetName: string;
  readonly parentSessionId?: string;
  readonly parentRunId?: string;
  readonly depth?: number;
  readonly sessionId?: string;
}

export interface SubagentRuntimeOptions {
  readonly maxDepth?: number;
  readonly maxConcurrentSubagents?: number;
}

export type SubagentRunState = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface SubagentRunNode {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly presetName: string;
  readonly depth: number;
  readonly state: SubagentRunState;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly parentSessionId?: string;
  readonly parentRunId?: string;
  readonly terminationReason?: AgentLoopResult["terminationReason"];
  readonly usage?: AgentLoopResult["usage"];
  readonly content?: string;
  readonly error?: string;
  readonly cancellationReason?: string;
  readonly cancellationError?: string;
  readonly children: readonly string[];
}

export interface SubagentTreeNode {
  readonly id: string;
  readonly label: string;
  readonly state: SubagentRunState;
  readonly depth: number;
  readonly children: readonly SubagentTreeNode[];
}

export interface SubagentSnapshot {
  readonly activeCount: number;
  readonly nodes: readonly SubagentRunNode[];
  readonly tree: readonly SubagentTreeNode[];
}

export interface SubagentCancelRequest {
  readonly sessionId: string;
  readonly subtree?: boolean;
  readonly reason?: string;
}

export interface SubagentCancelTargetResult {
  readonly sessionId: string;
  readonly status: "accepted" | "rejected";
  readonly reason: string;
}

export interface SubagentCancelResult {
  readonly sessionId: string;
  readonly scope: "node" | "subtree";
  readonly status: "accepted" | "rejected";
  readonly targets: readonly SubagentCancelTargetResult[];
}

export interface CreateSubagentSessionRequest {
  readonly preset: AgentPresetV1;
  readonly sessionId: string;
  readonly depth: number;
  readonly parentSessionId?: string;
  readonly parentRunId?: string;
}

export interface SubagentDependencies {
  readonly presets: AgentPresetRegistry;
  readonly createSession: (request: CreateSubagentSessionRequest) => AgentSession;
}

export class SubagentManager {
  readonly #deps: SubagentDependencies;
  readonly #runtime: SubagentRuntimeOptions;
  readonly #active = new Set<string>();
  readonly #activeSessions = new Map<string, AgentSession>();
  readonly #cancelRequested = new Set<string>();
  readonly #nodes = new Map<string, SubagentRunNode>();

  constructor(deps: SubagentDependencies, runtime: SubagentRuntimeOptions = {}) {
    this.#deps = deps;
    this.#runtime = runtime;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  snapshot(): SubagentSnapshot {
    const nodes = [...this.#nodes.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const byParent = new Map<string, string[]>();
    const rootIds: string[] = [];
    for (const node of nodes) {
      const parentKey = node.parentSessionId ?? node.parentRunId;
      if (!parentKey || !this.#nodes.has(parentKey)) {
        rootIds.push(node.sessionId);
        continue;
      }
      const children = byParent.get(parentKey) ?? [];
      children.push(node.sessionId);
      byParent.set(parentKey, children);
    }
    const tree = rootIds.map((id) => buildTreeNode(id, this.#nodes, byParent));
    return {
      activeCount: this.activeCount,
      nodes,
      tree,
    };
  }

  cancel(request: SubagentCancelRequest): SubagentCancelResult {
    const node = this.#nodes.get(request.sessionId);
    const scope = request.subtree === true ? "subtree" : "node";
    if (!node) {
      return {
        sessionId: request.sessionId,
        scope,
        status: "rejected",
        targets: [{ sessionId: request.sessionId, status: "rejected", reason: "Subagent was not found." }],
      };
    }

    const targets = (request.subtree === true
      ? this.#collectSubtree(request.sessionId)
      : [node])
      .sort((left, right) => right.depth - left.depth)
      .map((target): SubagentCancelTargetResult => this.#cancelTarget(target, request.reason ?? "Cancelled by user"));
    return {
      sessionId: request.sessionId,
      scope,
      status: targets.some((target) => target.status === "accepted") ? "accepted" : "rejected",
      targets,
    };
  }

  async spawn(request: SubagentSpawnRequest): Promise<AgentLoopResult> {
    const preset = this.#deps.presets.get(request.presetName);
    if (!preset) {
      throw new Error(`Unknown preset: ${request.presetName}`);
    }

    const maxDepth = this.#runtime.maxDepth ?? 3;
    const depth = request.depth ?? 1;
    if (depth > maxDepth) {
      throw new Error(`Subagent depth limit exceeded: ${depth}/${maxDepth}`);
    }

    const maxConcurrent = this.#runtime.maxConcurrentSubagents ?? 4;
    if (this.#active.size >= maxConcurrent) {
      throw new Error("Subagent concurrency limit exceeded");
    }

    const sessionId = request.sessionId ?? `subagent-${randomUUID()}`;
    assertSafeIdentifier(sessionId, "Subagent session ID");
    const startedAt = new Date().toISOString();
    this.#nodes.set(sessionId, {
      id: sessionId,
      sessionId,
      prompt: request.prompt,
      presetName: request.presetName,
      depth,
      state: "pending",
      startedAt,
      ...(request.parentSessionId !== undefined ? { parentSessionId: request.parentSessionId } : {}),
      ...(request.parentRunId !== undefined ? { parentRunId: request.parentRunId } : {}),
      children: [],
    });
    this.#setState(sessionId, "running");

    this.#active.add(sessionId);
    try {
      const session = this.#deps.createSession({
        preset,
        sessionId,
        depth,
        ...(request.parentSessionId !== undefined ? { parentSessionId: request.parentSessionId } : {}),
        ...(request.parentRunId !== undefined ? { parentRunId: request.parentRunId } : {}),
      });
      this.#activeSessions.set(sessionId, session);
      const result = await session.prompt(request.prompt);
      if (!this.#cancelRequested.has(sessionId)) {
        this.#setResult(sessionId, "completed", result);
      }
      return result;
    } catch (error) {
      if (!this.#cancelRequested.has(sessionId)) {
        this.#setError(sessionId, error);
      }
      throw error;
    } finally {
      this.#active.delete(sessionId);
      this.#activeSessions.delete(sessionId);
      this.#cancelRequested.delete(sessionId);
      const node = this.#nodes.get(sessionId);
      if (node && node.state === "running") {
        this.#setState(sessionId, "cancelled");
      }
    }
  }

  #collectSubtree(sessionId: string): SubagentRunNode[] {
    const result: SubagentRunNode[] = [];
    const visit = (id: string): void => {
      const current = this.#nodes.get(id);
      if (!current) return;
      result.push(current);
      for (const child of this.#nodes.values()) {
        if (child.parentSessionId === id || child.parentRunId === id) visit(child.sessionId);
      }
    };
    visit(sessionId);
    return result;
  }

  #cancelTarget(node: SubagentRunNode, reason: string): SubagentCancelTargetResult {
    const session = this.#activeSessions.get(node.sessionId);
    if (node.state !== "running" || !session) {
      return {
        sessionId: node.sessionId,
        status: "rejected",
        reason: node.state === "running" ? "Subagent session is not cancellable yet." : `Subagent already ${node.state}.`,
      };
    }
    this.#cancelRequested.add(node.sessionId);
    try {
      session.abort(reason);
      this.#nodes.set(node.sessionId, {
        ...node,
        state: "cancelled",
        endedAt: new Date().toISOString(),
        cancellationReason: reason,
      });
      return { sessionId: node.sessionId, status: "accepted", reason };
    } catch (error) {
      this.#cancelRequested.delete(node.sessionId);
      const message = error instanceof Error ? error.message : String(error);
      this.#nodes.set(node.sessionId, { ...node, cancellationError: message });
      return { sessionId: node.sessionId, status: "rejected", reason: `Cancellation failed: ${message}` };
    }
  }

  #setState(sessionId: string, state: SubagentRunState): void {
    const node = this.#nodes.get(sessionId);
    if (!node) {
      return;
    }
    this.#nodes.set(sessionId, {
      ...node,
      state,
      ...(state === "running" ? {} : { endedAt: new Date().toISOString() }),
    });
  }

  #setResult(sessionId: string, state: SubagentRunState, result: AgentLoopResult): void {
    const node = this.#nodes.get(sessionId);
    if (!node) {
      return;
    }
    this.#nodes.set(sessionId, {
      ...node,
      state,
      endedAt: new Date().toISOString(),
      terminationReason: result.terminationReason,
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      content: result.content,
    });
  }

  #setError(sessionId: string, error: unknown): void {
    const node = this.#nodes.get(sessionId);
    if (!node) {
      return;
    }
    this.#nodes.set(sessionId, {
      ...node,
      state: "failed",
      endedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function filterPresetTools<T extends { name: string }>(
  preset: AgentPresetV1,
  tools: readonly T[],
): T[] {
  if (!preset.tools?.length) {
    return [...tools];
  }
  const allowed = new Set(preset.tools);
  return tools.filter((tool) => allowed.has(tool.name));
}

function buildTreeNode(
  id: string,
  nodes: ReadonlyMap<string, SubagentRunNode>,
  byParent: ReadonlyMap<string, string[]>,
): SubagentTreeNode {
  const node = nodes.get(id);
  if (!node) {
    return {
      id,
      label: id,
      state: "failed",
      depth: 0,
      children: [],
    };
  }
  const children = (byParent.get(id) ?? []).map((childId) => buildTreeNode(childId, nodes, byParent));
  const status = node.state === "running" ? "running"
    : node.state === "completed" ? "completed"
      : node.state === "cancelled" ? "cancelled"
        : node.state === "pending" ? "pending"
          : "failed";
  return {
    id: node.sessionId,
    label: `${node.sessionId} • ${node.presetName} • ${node.state}`,
    state: status,
    depth: node.depth,
    children,
  };
}
