import { randomUUID } from "node:crypto";

import type { ApprovalHandler, ApprovalPrompt, ApprovalResponse } from "../approval/types.js";
import type { AgentSession } from "../core/agent-session.js";
import type { AgentLoopResult } from "../core/types.js";
import type { AgentEvent } from "../events/types.js";
import { redactText } from "../redaction/redactor.js";
import type { SessionExtensionSnapshot } from "../session/types.js";
import { CliRuntimeProjection } from "./runtime-projection.js";
import type { CliRuntimeContext, CliRuntimeSnapshot, CliSessionRequest } from "./runtime-types.js";
import { buildSessionReplay } from "./session-replay.js";

export interface RuntimeAdapterOptions {
  readonly runtime: CliRuntimeContext;
  readonly session: AgentSession;
  readonly modelKey?: string;
  readonly sessionId?: string;
  readonly approvalHandler?: ApprovalHandler;
  readonly onChange?: () => void;
  readonly onDiagnostic?: (message: string) => void;
}

export class RuntimeAdapter {
  readonly runtime: CliRuntimeContext;
  readonly projection = new CliRuntimeProjection();
  readonly #approvalHandler: ApprovalHandler | undefined;
  readonly #onChange: (() => void) | undefined;
  readonly #onDiagnostic: ((message: string) => void) | undefined;
  #session: AgentSession;
  #sessionId: string | undefined;
  #modelKey: string | undefined;
  #snapshot: CliRuntimeSnapshot | undefined;
  #unsubscribe: (() => void) | undefined;
  #running = false;
  #extensionSnapshot: SessionExtensionSnapshot | undefined;

  constructor(options: RuntimeAdapterOptions) {
    this.runtime = options.runtime;
    this.#session = options.session;
    this.#sessionId = options.sessionId;
    this.#modelKey = options.modelKey;
    this.#approvalHandler = options.approvalHandler;
    this.#onChange = options.onChange;
    this.#onDiagnostic = options.onDiagnostic;
    this.projection.setEmptyHint(emptyHint());
    this.#bindSession(options.session);
  }

  get session(): AgentSession {
    return this.#session;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get modelKey(): string | undefined {
    return this.#modelKey;
  }

  get snapshot(): CliRuntimeSnapshot | undefined {
    return this.#snapshot;
  }

  get running(): boolean {
    return this.#running || this.projection.state.running;
  }

  get diagnostics(): readonly string[] {
    return this.projection.diagnostics;
  }

  get extensionSnapshot(): SessionExtensionSnapshot | undefined {
    return this.#extensionSnapshot;
  }

  async initialize(): Promise<void> {
    await this.refreshSnapshot();
    if (!this.#modelKey) this.#modelKey = this.#snapshot?.defaultModel;
    if (this.#sessionId) await this.replay(this.#sessionId);
  }

  async refreshSnapshot(): Promise<CliRuntimeSnapshot> {
    this.#snapshot = await this.runtime.snapshot();
    this.#onChange?.();
    return this.#snapshot;
  }

  async replay(sessionId: string): Promise<void> {
    const document = await this.runtime.loadSessionDocument?.(sessionId);
    if (!document) {
      this.#diagnose(`Session replay unavailable for ${sessionId}.`);
      return;
    }
    const replay = buildSessionReplay(document);
    this.projection.clear();
    this.projection.setEmptyHint(emptyHint());
    for (const block of replay.blocks) this.projection.applyPresentationBlock(block);
    for (const diagnostic of replay.diagnostics) this.#diagnose(diagnostic);
    this.#extensionSnapshot = replay.extensionSnapshot;
    this.#onChange?.();
  }

  async runPrompt(prompt: string): Promise<AgentLoopResult | undefined> {
    const cleaned = prompt.trim();
    if (!cleaned) return undefined;
    if (this.running) {
      this.#session.followUp(cleaned);
      this.addStatus("queued follow-up", [cleaned]);
      return undefined;
    }

    this.#running = true;
    this.projection.setRunning(true);
    this.projection.pushUserMessage(this.#nextId("user"), cleaned);
    this.#onChange?.();
    try {
      const result = await this.#session.prompt(cleaned);
      this.#sessionId = result.sessionId ?? this.#sessionId;
      this.projection.setLastStatus(`${result.terminationReason}${result.usage ? ` | ${result.usage.totalTokens} tokens` : ""}`);
      this.projection.addStatus(this.#nextId("status"), "run", [
        `termination: ${result.terminationReason}`,
        ...(result.usage ? [
          `inputTokens: ${result.usage.inputTokens}`,
          `outputTokens: ${result.usage.outputTokens}`,
          `totalTokens: ${result.usage.totalTokens}`,
          `modelRequests: ${result.usage.modelRequests}`,
        ] : []),
      ]);
      return result;
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      this.projection.setLastStatus(`Error: ${message}`);
      if (!this.projection.hasBlock("agent-error")) {
        this.projection.addError(this.#nextId("error"), "run error", message);
      }
      this.#diagnose(`Run failed: ${message}`);
      return undefined;
    } finally {
      this.#running = false;
      this.projection.setRunning(false);
      await this.refreshSnapshot();
      await this.#persistPresentation();
      this.#onChange?.();
    }
  }

  async switchSession(request: CliSessionRequest): Promise<boolean> {
    if (this.running) {
      this.projection.addError(this.#nextId("error"), "busy", "Wait for the current run to finish before switching session or model.");
      this.#onChange?.();
      return false;
    }
    this.#session = this.runtime.createSession({
      ...(request.modelKey !== undefined ? { modelKey: request.modelKey } : {}),
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      ...(request.preset !== undefined ? { preset: request.preset } : {}),
      interactive: true,
      ...(this.#approvalHandler !== undefined ? { approvalHandler: this.#approvalHandler } : {}),
    });
    this.#modelKey = request.modelKey ?? this.#modelKey;
    this.#sessionId = request.sessionId;
    this.#bindSession(this.#session);
    this.projection.clear();
    this.projection.setEmptyHint(emptyHint());
    if (request.sessionId) await this.replay(request.sessionId);
    this.addStatus("session switched", [
      `model: ${this.#modelKey ?? "default"}`,
      `session: ${this.#sessionId ?? "new"}`,
    ]);
    await this.refreshSnapshot();
    return true;
  }

  followUp(prompt: string): void {
    this.#session.followUp(prompt);
    this.addStatus("queued follow-up", [prompt]);
  }

  steer(message: string): void {
    this.#session.steer(message);
  }

  abort(reason?: string): void {
    this.#session.abort(reason);
    this.projection.setLastStatus("Run aborted");
    this.#onChange?.();
  }

  addStatus(title: string, lines: readonly string[]): void {
    this.projection.addStatus(this.#nextId("status"), title, lines);
    this.#onChange?.();
  }

  addError(title: string, error: unknown): void {
    this.projection.addError(this.#nextId("error"), title, error);
    this.#onChange?.();
  }

  recordApproval(prompt: ApprovalPrompt, response: ApprovalResponse | undefined): void {
    this.projection.addApprovalResult(this.#nextId("approval"), prompt, response);
    this.#onChange?.();
  }

  clearPresentation(): void {
    this.projection.clear();
    this.projection.setEmptyHint(emptyHint());
    this.#onChange?.();
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  #bindSession(session: AgentSession): void {
    this.#unsubscribe?.();
    this.#unsubscribe = session.subscribe((event) => this.#handleEvent(event));
  }

  #handleEvent(event: AgentEvent): void {
    const result = this.projection.applyAgentEvent(event);
    if (result.changed) this.#onChange?.();
  }

  async #persistPresentation(): Promise<void> {
    if (!this.#sessionId || !this.runtime.saveSessionPresentation) return;
    const snapshot = this.#snapshot;
    const extensionSnapshot: SessionExtensionSnapshot | undefined = snapshot ? {
      capturedAt: new Date().toISOString(),
      extensions: snapshot.extensions.map((extension) => ({
        id: extension.id,
        version: extension.version,
        enabled: extension.enabled,
        health: extension.health,
      })),
    } : undefined;
    try {
      await this.runtime.saveSessionPresentation({
        sessionId: this.#sessionId,
        blocks: this.projection.presentationBlocks(),
        ...(extensionSnapshot !== undefined ? { extensionSnapshot } : {}),
      });
      this.#extensionSnapshot = extensionSnapshot;
    } catch (error) {
      this.#diagnose(`Presentation snapshot was not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #diagnose(message: string): void {
    this.projection.addDiagnostic(message);
    this.#onDiagnostic?.(message);
  }

  #nextId(prefix: string): string {
    return `cli:${prefix}:${randomUUID()}`;
  }
}

function emptyHint(): string[] {
  return [
    "No messages yet. Type a prompt or /help.",
    "Try /status, /extensions, or /agents to inspect the runtime.",
  ];
}
