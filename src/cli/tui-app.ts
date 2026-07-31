import type { AgentSession } from "../core/agent-session.js";
import type { ApprovalPrompt, ApprovalResponse } from "../approval/types.js";
import { ProcessTerminal, TuiHost, type KeyInput, type PreparedRenderFrame } from "@mingxu/tui";
import type { CliRuntimeContext, CliRuntimeSnapshot } from "./runtime-types.js";
import { resolveTranscriptTheme } from "./transcript-theme.js";
import { RuntimeAdapter } from "./runtime-adapter.js";
import { ProductScreen, type ActiveProductPanel } from "./product-screen.js";
import { createProductCommandController } from "./product-command-controller.js";
import type { CommandController } from "./command-controller.js";

export class CliTuiApp {
  readonly #terminal: ProcessTerminal;
  readonly #processTarget: Pick<NodeJS.Process, "on" | "off">;
  readonly #adapter: RuntimeAdapter;
  readonly #screen: ProductScreen;
  readonly #commands: CommandController;
  readonly #host: TuiHost;
  #exitRequested = false;
  #exitArmed = false;
  #ctrlDArmed = false;
  #terminalKeySubscription: (() => void) | undefined;
  #terminalResizeSubscription: (() => void) | undefined;
  #terminalErrorSubscription: (() => void) | undefined;
  #processSubscription: (() => void) | undefined;
  #finishResolver: ((exitCode: number) => void) | undefined;
  #shutdownCompleted = false;
  #terminalActive = false;

  constructor(options: {
    runtime: CliRuntimeContext;
    terminal: ProcessTerminal;
    session: AgentSession;
    modelKey?: string;
    sessionId?: string;
    plain?: boolean;
    processTarget?: Pick<NodeJS.Process, "on" | "off">;
  }) {
    this.#terminal = options.terminal;
    this.#processTarget = options.processTarget ?? process;
    let screen: ProductScreen | undefined;
    this.#adapter = new RuntimeAdapter({
      runtime: options.runtime,
      session: options.session,
      ...(options.modelKey !== undefined ? { modelKey: options.modelKey } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      approvalHandler: (prompt) => screen?.openApproval(prompt),
      onChange: () => this.#requestRender(),
    });
    let commands: CommandController | undefined;
    this.#screen = new ProductScreen({
      projection: this.#adapter.projection,
      theme: resolveTranscriptTheme({ ...(options.plain === true ? { plain: true } : {}) }),
      terminalRows: () => this.#terminal.size.rows,
      state: () => ({
        snapshot: this.#adapter.snapshot,
        sessionId: this.#adapter.sessionId,
        modelKey: this.#adapter.modelKey,
        running: this.#adapter.running,
        contextMessages: this.#adapter.session.state.messages.length,
      }),
      completions: (value) => (commands?.suggestions(value) ?? []).map((command) => ({
        id: command.name,
        label: command.usage,
        description: command.description,
      })),
      requestRender: (renderOptions) => this.#requestRender(renderOptions),
      switchSession: (request) => this.#adapter.switchSession(request),
      cancelSubagents: async (sessionId, subtree) => {
        const result = await this.#adapter.runtime.cancelSubagents?.({
          sessionId,
          subtree,
          reason: "Cancelled from Agent Tree",
        });
        await this.#adapter.refreshSnapshot();
        return result;
      },
      onApproval: (prompt, response) => this.#adapter.recordApproval(prompt, response),
    });
    screen = this.#screen;
    this.#commands = createProductCommandController({
      adapter: this.#adapter,
      screen: this.#screen,
      exit: () => this.exit(),
      requestRender: () => this.#requestRender(),
    });
    commands = this.#commands;
    this.#host = new TuiHost(this.#terminal, this.#screen);
  }

  async start(initialPrompt?: string): Promise<number> {
    try {
      await this.#adapter.initialize();
      const completion = new Promise<number>((resolve) => {
        this.#finishResolver = resolve;
      });
      this.#exitRequested = false;
      this.#terminalKeySubscription = this.#terminal.onKeypress((input) => this.#handleKeypress(input));
      this.#terminalResizeSubscription = this.#terminal.onResize(() => this.#host.requestRender());
      this.#terminalErrorSubscription = this.#terminal.onError?.((error) => this.#handleTerminalError(error));
      const entered = this.#terminal.enterRawMode();
      if (entered === false) throw new Error("Interactive terminal capabilities are unavailable.");
      this.#processSubscription = this.#terminal.bindProcessHandlers?.({
        onSignal: (signal) => this.#handleProcessSignal(signal),
        onFatalError: (error) => this.#handleFatalError(error),
      }, this.#processTarget);
      this.#terminal.hideCursor();
      this.#terminalActive = true;
      this.#host.requestRender({ full: true });
      if (initialPrompt?.trim()) this.#enqueuePrompt(initialPrompt.trim());
      this.#tryFinish();
      return await completion;
    } finally {
      this.#shutdown();
    }
  }

  get runtimeSnapshot(): CliRuntimeSnapshot | undefined { return this.#adapter.snapshot; }
  get currentSessionId(): string | undefined { return this.#adapter.sessionId; }
  get currentModelKey(): string | undefined { return this.#adapter.modelKey; }
  get currentSession(): AgentSession { return this.#adapter.session; }
  get isRunning(): boolean { return this.#adapter.running; }
  get activePanel(): ActiveProductPanel { return this.#screen.activePanel; }
  get editor() { return this.#screen.editor; }
  get transcriptStats(): { readonly committedBlockCount: number; readonly activeBlockCount: number } {
    return {
      committedBlockCount: this.#adapter.projection.committedBlockCount,
      activeBlockCount: this.#adapter.projection.activeBlockCount,
    };
  }

  async refreshSnapshot(): Promise<void> {
    await this.#adapter.refreshSnapshot();
  }

  queuePrompt(prompt: string): void { this.#enqueuePrompt(prompt); }

  exit(): void {
    this.#exitRequested = true;
    this.#tryFinish();
  }

  async runPrompt(prompt: string): Promise<void> {
    this.#exitArmed = false;
    this.#ctrlDArmed = false;
    await this.#adapter.runPrompt(prompt);
    this.#host.requestRender();
    this.#tryFinish();
  }

  async handleSubmit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    this.#screen.hideWelcome();
    this.#screen.setComposerNotice(undefined);
    if (!trimmed.startsWith("/")) {
      await this.runPrompt(trimmed);
      return;
    }
    const result = await this.#commands.dispatch(trimmed);
    if (result.status === "unknown") {
      const parsed = this.#commands.parse(trimmed);
      this.#screen.setComposerNotice(`Unknown command /${parsed?.name ?? trimmed}`);
    } else if (result.status === "error") {
      this.#adapter.addError("command", result.error ?? "Command failed");
    }
    this.#host.requestRender();
  }

  handleInput(input: KeyInput): void {
    if (this.#screen.handleOverlayInput(input)) return;
    if (input.ctrl && input.name === "c") {
      if (this.#adapter.running) {
        this.#adapter.abort("Interrupted by user");
      } else if (this.editor.value.trim()) {
        this.editor.clear();
        this.#exitArmed = false;
        this.#ctrlDArmed = false;
        this.#adapter.projection.setLastStatus("Draft cleared");
      } else if (this.#exitArmed) this.exit();
      else {
        this.#exitArmed = true;
        this.#adapter.projection.setLastStatus("Press Ctrl+C again to exit");
      }
      this.#host.requestRender();
      return;
    }
    if (input.ctrl && input.name === "d") {
      if (this.editor.value.trim()) {
        this.#screen.handleEditorInput({ sequence: "", name: "delete" });
      } else if (this.#ctrlDArmed) this.exit();
      else {
        this.#ctrlDArmed = true;
        this.#adapter.projection.setLastStatus("Press Ctrl+D again to exit");
      }
      this.#host.requestRender();
      return;
    }
    if (input.ctrl && input.name === "l") {
      this.#host.requestRender({ full: true });
      return;
    }
    if (input.ctrl && input.name === "o") {
      const detailed = this.#screen.toggleDetailedTranscript();
      this.#adapter.projection.setLastStatus(detailed ? "Detailed transcript on" : "Detailed transcript off");
      this.#host.requestRender();
      return;
    }
    this.#exitArmed = false;
    this.#ctrlDArmed = false;
    const action = this.#screen.handleEditorInput(input);
    if (action?.type === "cancel") this.exit();
    else if (action?.type === "submit") void this.handleSubmit(action.value).catch((error) => this.#adapter.addError("command", error));
    this.#host.requestRender();
  }

  async openHelpPanel(): Promise<void> { this.#screen.openHelp(this.#commands.help().split("\n")); }
  async openStatusPanel(): Promise<void> { await this.#ensureSnapshot(); this.#screen.openStatus(); }
  async openContextPanel(): Promise<void> { await this.#ensureSnapshot(); this.#screen.openContext(); }
  async openAuditPanel(): Promise<void> { await this.#ensureSnapshot(); this.#screen.openAudit(); }
  async openTrustPanel(): Promise<void> { await this.#ensureSnapshot(); this.#screen.openTrust(); }
  async openExtensionsPanel(): Promise<void> { await this.#ensureSnapshot(); this.#screen.openExtensions(); }
  async openAgentsPanel(): Promise<void> { await this.#ensureSnapshot(); this.#screen.openAgents(); }
  async openPresetPanel(): Promise<void> { await this.#ensureSnapshot(); this.#screen.openPresets(); }
  async openSessionsPanel(): Promise<void> { await this.#ensureSnapshot(); this.#screen.openSessions(); }
  async openModelPanel(): Promise<void> { await this.#ensureSnapshot(); this.#screen.openModels(); }
  async openApproval(prompt: ApprovalPrompt): Promise<ApprovalResponse | undefined> { return this.#screen.openApproval(prompt); }
  render(width: number, height?: number): string[] { return this.#screen.render(width, height); }
  prepareFrame(width: number, height: number | undefined, options: { readonly full: boolean }): PreparedRenderFrame {
    return this.#screen.prepareFrame(width, height, options);
  }

  async #ensureSnapshot(): Promise<void> {
    if (!this.#adapter.snapshot) await this.#adapter.refreshSnapshot();
  }

  #enqueuePrompt(prompt: string): void {
    if (!prompt.trim()) return;
    if (this.#adapter.running) this.#adapter.followUp(prompt.trim());
    else void this.runPrompt(prompt.trim());
  }

  #handleKeypress(input: KeyInput): void { this.handleInput(input); }

  #handleFatalError(error: unknown): void {
    this.#adapter.addError("fatal error", error instanceof Error ? error.message : String(error));
    this.#terminate(1);
  }

  #handleTerminalError(error: unknown): void { this.#terminate(isBrokenPipeError(error) ? 0 : 1); }

  #handleProcessSignal(signal: NodeJS.Signals): void {
    this.#terminate(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129, `Interrupted by ${signal}`);
  }

  #shutdown(): void {
    if (this.#shutdownCompleted) return;
    this.#shutdownCompleted = true;
    this.#terminalActive = false;
    this.#host.dispose();
    this.#terminalKeySubscription?.();
    this.#terminalResizeSubscription?.();
    this.#terminalErrorSubscription?.();
    this.#processSubscription?.();
    this.#terminalKeySubscription = undefined;
    this.#terminalResizeSubscription = undefined;
    this.#terminalErrorSubscription = undefined;
    this.#processSubscription = undefined;
    this.#adapter.dispose();
    this.#terminal.restore();
  }

  #requestRender(options?: { readonly full?: boolean }): void {
    if (!this.#terminalActive) return;
    this.#host.requestRender(options?.full ? { full: true } : undefined);
  }

  #terminate(exitCode: number, abortReason?: string): void {
    if (abortReason && this.#adapter.running) this.#adapter.abort(abortReason);
    this.#exitRequested = true;
    this.#screen.closePendingApproval();
    const resolve = this.#finishResolver;
    this.#finishResolver = undefined;
    this.#shutdown();
    resolve?.(exitCode);
  }

  #tryFinish(): void {
    if (!this.#exitRequested || this.#adapter.running || !this.#finishResolver) return;
    const resolve = this.#finishResolver;
    this.#finishResolver = undefined;
    this.#shutdown();
    resolve(0);
  }
}

function isBrokenPipeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === "EPIPE";
}
