import { inspect } from "node:util";

import { AgentSession } from "../core/agent-session.js";
import type { AgentEvent } from "../events/types.js";
import type { ApprovalPrompt, ApprovalResponse, ApprovalResponseScope } from "../approval/types.js";
import { ProcessTerminal, Box, Editor, KeyValue, Markdown, SelectList, Table, Text, Tree, TuiHost, type SelectListItem, type TreeNode, type KeyInput, type Component, type InlineFrameComponent, type OverlayFrame, type PreparedRenderFrame } from "@mingxu/tui";
import { truncateToWidth, visibleWidth, wrapText } from "@mingxu/tui";
import type { CliRuntimeContext, CliRuntimeSnapshot, CliSessionRequest } from "./runtime-types.js";
import { formatChatHelp, suggestChatCommands } from "./chat-commands.js";
import { redactText, redactValue } from "../redaction/redactor.js";
import { resolveTranscriptTheme } from "./transcript-theme.js";
import { OverlayHost } from "@mingxu/tui";
import { CliRuntimeProjection } from "./runtime-projection.js";

interface SelectPanelItem<T = string> {
  readonly id: string;
  readonly label: string;
  readonly detailLines: readonly string[];
  readonly value: T;
}

interface TextPanel {
  readonly kind: "text";
  readonly title: string;
  readonly lines: readonly string[];
  scrollOffset: number;
}

interface SelectPanel<T = string> {
  readonly kind: "select";
  readonly title: string;
  readonly items: readonly SelectPanelItem<T>[];
  selectedIndex: number;
  scrollOffset: number;
  readonly note?: string;
  filterText?: string;
  readonly onChoose: (item: SelectPanelItem<T>) => Promise<void> | void;
}

type ActivePanel = TextPanel | SelectPanel | undefined;

interface PendingApproval {
  readonly prompt: ApprovalPrompt;
  readonly items: readonly SelectPanelItem<ApprovalResponse>[];
  selectedIndex: number;
  readonly resolve: (response: ApprovalResponse | undefined) => void;
}

export class CliTuiApp {
  readonly #runtime: CliRuntimeContext;
  readonly #terminal: ProcessTerminal;
  readonly #host: TuiHost;
  readonly #screen: CliTuiScreen;
  readonly #editor: Editor;
  readonly #conversation = new CliRuntimeProjection();
  readonly #transcriptTheme;
  readonly #overlays = new OverlayHost();
  #snapshot: CliRuntimeSnapshot | undefined;
  #currentSession: AgentSession;
  #currentSessionId: string | undefined;
  #currentModelKey: string | undefined;
  #running = false;
  #exitRequested = false;
  #exitArmed = false;
  #ctrlDArmed = false;
  #detailedTranscript = false;
  #showWelcomeBanner = true;
  #panelStack: NonNullable<ActivePanel>[] = [];
  #activePanel: ActivePanel = undefined;
  #approval: PendingApproval | undefined;
  #sessionSubscription: (() => void) | undefined;
  #composerNotice: string | undefined;
  #blockSeq = 0;
  #finishResolver: ((exitCode: number) => void) | undefined;
  #shutdownCompleted = false;

  constructor(options: {
    runtime: CliRuntimeContext;
    terminal: ProcessTerminal;
    session: AgentSession;
    modelKey?: string;
    sessionId?: string;
    plain?: boolean;
  }) {
    this.#runtime = options.runtime;
    this.#terminal = options.terminal;
    this.#currentSession = options.session;
    this.#currentSessionId = options.sessionId;
    this.#currentModelKey = options.modelKey;
    this.#transcriptTheme = resolveTranscriptTheme({
      ...(options.plain === true ? { plain: true } : {}),
    });
    this.#conversation.setEmptyHint([
      "No messages yet. Type a prompt or /help.",
      "Try /status, /extensions, or /agents to inspect the runtime.",
    ]);
    this.#editor = new Editor({
      prompt: "> ",
      completionProvider: (value) => suggestChatCommands(value).map((command) => ({
        id: command.name,
        label: command.usage,
        description: command.description,
      })),
    });
    this.#screen = new CliTuiScreen(this);
    this.#host = new TuiHost(this.#terminal, this.#screen);
  }

  async start(initialPrompt?: string): Promise<number> {
    try {
      await this.#refreshSnapshot();
      if (!this.#currentModelKey && this.#snapshot) {
        this.#currentModelKey = this.#snapshot.defaultModel;
      }
      this.#bindSession(this.#currentSession);
      this.#terminal.enterRawMode();
      this.#terminal.hideCursor();
      this.#terminal.onKeypress((input) => this.#handleKeypress(input));
      this.#terminal.onResize(() => this.#host.requestRender());
      this.#host.requestRender({ full: true });

      if (initialPrompt?.trim()) {
        this.#enqueuePrompt(initialPrompt.trim());
      }

      return await new Promise<number>((resolve) => {
        this.#finishResolver = resolve;
        this.#exitRequested = false;
        this.#tryFinish();
      });
    } finally {
      this.#shutdown();
    }
  }

  get runtimeSnapshot(): CliRuntimeSnapshot | undefined {
    return this.#snapshot;
  }

  get currentSessionId(): string | undefined {
    return this.#currentSessionId;
  }

  get currentModelKey(): string | undefined {
    return this.#currentModelKey;
  }

  get currentSession(): AgentSession {
    return this.#currentSession;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  get transcriptStats(): { readonly committedBlockCount: number; readonly activeBlockCount: number } {
    return {
      committedBlockCount: this.#conversation.committedBlockCount,
      activeBlockCount: this.#conversation.activeBlockCount,
    };
  }

  get activePanel(): ActivePanel {
    return this.#activePanel;
  }

  #setPanel(panel: ActivePanel | undefined): void {
    this.#panelStack = panel ? [panel] : [];
    this.#activePanel = panel;
  }

  #pushPanel(panel: NonNullable<ActivePanel>): void {
    this.#panelStack.push(panel);
    this.#activePanel = panel;
  }

  #popPanel(): void {
    this.#panelStack.pop();
    this.#activePanel = this.#panelStack.at(-1);
  }

  #clearPanels(): void {
    this.#panelStack = [];
    this.#activePanel = undefined;
  }

  get editor(): Editor {
    return this.#editor;
  }

  async refreshSnapshot(): Promise<void> {
    await this.#refreshSnapshot();
    this.#host.requestRender();
  }

  queuePrompt(prompt: string): void {
    this.#enqueuePrompt(prompt);
  }

  exit(): void {
    this.#exitRequested = true;
    this.#tryFinish();
  }

  async runPrompt(prompt: string): Promise<void> {
    const cleaned = prompt.trim();
    if (!cleaned) return;

    if (this.#running) {
      this.#currentSession.followUp(cleaned);
      this.#pushStatus(`Queued follow-up: ${cleaned}`);
      this.#conversation.addStatus(this.#nextBlockId("status"), "queued follow-up", [cleaned]);
      this.#host.requestRender();
      return;
    }

    this.#running = true;
    this.#exitArmed = false;
    this.#ctrlDArmed = false;
    this.#pushUserBlock(cleaned);
    this.#host.requestRender();

    try {
      const result = await this.#currentSession.prompt(cleaned);
      this.#currentSessionId = result.sessionId ?? this.#currentSessionId;
      this.#pushStatus(`${result.terminationReason}${result.usage ? ` · ${result.usage.totalTokens ?? 0} tokens` : ""}`);
      this.#conversation.addStatus(this.#nextBlockId("status"), "run", [
        `termination: ${result.terminationReason}`,
        ...(result.usage !== undefined
          ? [
              `inputTokens: ${result.usage.inputTokens}`,
              `outputTokens: ${result.usage.outputTokens}`,
              `totalTokens: ${result.usage.totalTokens}`,
              `modelRequests: ${result.usage.modelRequests}`,
            ]
          : []),
      ]);
    } catch (error) {
      this.#pushStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
      this.#conversation.addError(this.#nextBlockId("error"), "run error", redactText(error instanceof Error ? error.message : String(error)));
      this.#handleFatalError(error);
      throw error;
    } finally {
      this.#running = false;
      await this.#refreshSnapshot();
      this.#host.requestRender();
      this.#tryFinish();
    }
  }

  async handleSubmit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    this.#showWelcomeBanner = false;
    if (trimmed.startsWith("/")) {
      await this.#handleCommand(trimmed);
      return;
    }
    await this.runPrompt(trimmed);
  }

  handleInput(input: KeyInput): void {
    this.#syncOverlayStack();
    if (this.#overlays.top) {
      this.#overlays.handleInput(input);
      return;
    }

    if (input.ctrl && input.name === "c") {
      if (this.#running) {
        this.#currentSession.abort("Interrupted by user");
        this.#pushStatus("Run aborted");
        this.#host.requestRender();
        return;
      }
      if (this.#editor.value.trim().length > 0) {
        this.#editor.clear();
        this.#exitArmed = false;
        this.#ctrlDArmed = false;
        this.#pushStatus("Draft cleared");
        this.#host.requestRender();
        return;
      }
      if (this.#exitArmed) {
        this.exit();
        return;
      }
      this.#exitArmed = true;
      this.#pushStatus("Press Ctrl+C again to exit");
      this.#host.requestRender();
      return;
    }

    if (input.ctrl && input.name === "d") {
      if (this.#editor.value.trim().length > 0) {
        const action = this.#editor.handleInput({ sequence: "", name: "delete" });
        if (action?.type === "submit") {
          void this.handleSubmit(action.value).catch(() => undefined);
        }
        this.#host.requestRender();
        return;
      }
      if (this.#ctrlDArmed) {
        this.exit();
        return;
      }
      this.#ctrlDArmed = true;
      this.#pushStatus("Press Ctrl+D again to exit");
      this.#host.requestRender();
      return;
    }

    if (input.ctrl && input.name === "l") {
      this.#host.requestRender({ full: true });
      return;
    }

    if (input.ctrl && input.name === "o") {
      this.#detailedTranscript = !this.#detailedTranscript;
      this.#pushStatus(this.#detailedTranscript ? "Detailed transcript on" : "Detailed transcript off");
      this.#host.requestRender();
      return;
    }

    this.#exitArmed = false;
    this.#ctrlDArmed = false;
    const action = this.#editor.handleInput(input);
    if (!action || action.type === "none") {
      this.#host.requestRender();
      return;
    }

    if (action.type === "cancel") {
      this.exit();
      return;
    }

    void this.handleSubmit(action.value).catch(() => undefined);
  }

  async openHelpPanel(): Promise<void> {
    this.#setPanel({
      kind: "text",
      title: "help",
      lines: formatChatHelp().split("\n"),
      scrollOffset: 0,
    });
    this.#host.requestRender();
  }

  async openStatusPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    this.#setPanel({
      kind: "text",
      title: "status",
      lines: [
        `session: ${this.#currentSessionId ?? "new"}`,
        `model: ${this.#currentModelKey ?? snapshot.defaultModel}`,
        `running: ${this.#running ? "yes" : "no"}`,
        `tools: ${(this.#currentSession.state.tools ?? []).length}`,
        `panel: ${this.#activePanel?.kind ?? "none"}`,
      ],
      scrollOffset: 0,
    });
    this.#host.requestRender();
  }

  async openContextPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    const lines = [
      `systemPrompt: ${snapshot.instructions.systemPrompt ? `${snapshot.instructions.systemPrompt.length} chars` : "none"}`,
      `managed instructions: ${joinList(snapshot.instructions.managed)}`,
      `user instructions: ${joinList(snapshot.instructions.user)}`,
      `project instructions: ${joinList(snapshot.instructions.project)}`,
      `local instructions: ${joinList(snapshot.instructions.local)}`,
      `session instructions: ${joinList(snapshot.instructions.session)}`,
      "",
      `resources: ${snapshot.resources.length}`,
      `skills: ${snapshot.skills.length}`,
      `presets: ${snapshot.presets.length}`,
      `message budget: ${this.#currentSession.state.messages.length}`,
    ];
    this.#setPanel({ kind: "text", title: "context", lines, scrollOffset: 0 });
    this.#host.requestRender();
  }

  async openAuditPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    this.#setPanel({
      kind: "text",
      title: "audit",
      lines: [
        `enabled: ${snapshot.audit.enabled}`,
        `file: ${snapshot.audit.file ?? "none"}`,
        `healthy: ${snapshot.audit.healthy}`,
        `failClosedForHighRisk: ${snapshot.audit.failClosedForHighRisk}`,
      ],
      scrollOffset: 0,
    });
    this.#host.requestRender();
  }

  async openTrustPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    this.#setPanel({
      kind: "text",
      title: "trust",
      lines: [
        `projectTrusted: ${snapshot.projectTrusted}`,
        ...snapshot.configSources.map((source) => `${source.kind}: ${source.path}`),
      ],
      scrollOffset: 0,
    });
    this.#host.requestRender();
  }

  async openExtensionsPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    const items: SelectPanelItem[] = [
      ...snapshot.extensions.map((extension) => ({
        id: `extension:${extension.id}`,
        label: `${extension.id} (${extension.enabled ? "enabled" : "disabled"})`,
        detailLines: [
          `name: ${extension.name}`,
          `version: ${extension.version}`,
          `adapter: ${extension.adapterId}`,
          `scope: ${extension.scope}`,
          `health: ${extension.health}`,
          `source: ${extension.source.kind}:${extension.source.locator}`,
          `entry: ${extension.entryPath}`,
          `permissions: ${extension.permissions ? JSON.stringify(extension.permissions) : "none"}`,
        ],
        value: extension.id,
      })),
      ...snapshot.presets.map((preset) => ({
        id: `preset:${preset.name}`,
        label: `preset ${preset.name}`,
        detailLines: [
          `description: ${preset.description}`,
          `modelKey: ${preset.modelKey ?? "default"}`,
          `skills: ${joinList(preset.skills)}`,
          `resources: ${joinList(preset.resources)}`,
          `tools: ${joinList(preset.tools)}`,
          `maxIterations: ${preset.maxIterations ?? "default"}`,
        ],
        value: preset.name,
      })),
      ...snapshot.skills.map((skill) => ({
        id: `skill:${skill.name}`,
        label: `skill ${skill.name}`,
        detailLines: [
          `version: ${skill.version}`,
          `description: ${skill.description}`,
          `entry: ${skill.entryPath}`,
          `visibility: ${skill.visibility}`,
        ],
        value: skill.name,
      })),
      ...snapshot.resources.map((resource) => ({
        id: `resource:${resource.kind}:${resource.name}`,
        label: `${resource.kind} ${resource.name}`,
        detailLines: [
          `visibility: ${resource.visibility}`,
          `source: ${resource.source ?? "local_file"}`,
          `path: ${resource.path ?? "inline"}`,
          `description: ${resource.description ?? "none"}`,
        ],
        value: resource.name,
      })),
      ...snapshot.mcpServers.map((server) => ({
        id: `mcp:${server.name}`,
        label: `mcp ${server.name}`,
        detailLines: [
          `transport: ${server.transport}`,
          `connected: ${server.connected}`,
        ],
        value: server.name,
      })),
    ];

    this.#setPanel({
      kind: "select",
      title: "extensions",
      items,
      selectedIndex: 0,
      scrollOffset: 0,
      note: "Use Up/Down to browse, Esc to close.",
      onChoose: async (item) => {
        this.#pushPanel({
          kind: "text",
          title: item.label,
          lines: item.detailLines.length > 0 ? [...item.detailLines] : ["No additional details."],
          scrollOffset: 0,
        });
        this.#host.requestRender();
      },
    });
    this.#host.requestRender();
  }

  async openAgentsPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    const nodes = snapshot.subagents.nodes.map((node) => ({
      id: node.id,
      label: `${node.sessionId} (${node.state})`,
      detailLines: [
        `preset: ${node.presetName}`,
        `depth: ${node.depth}`,
        `sessionId: ${node.sessionId}`,
        `parentSessionId: ${node.parentSessionId ?? "none"}`,
        `parentRunId: ${node.parentRunId ?? "none"}`,
        `startedAt: ${node.startedAt}`,
        `endedAt: ${node.endedAt ?? "running"}`,
        `terminationReason: ${node.terminationReason ?? "n/a"}`,
        `content: ${node.content ? truncateToWidth(node.content, 120) : "none"}`,
        `error: ${node.error ?? "none"}`,
      ],
      value: node.id,
    }));
    const treeLines = snapshot.subagents.tree.length > 0
      ? [renderTree(snapshot.subagents.tree)]
      : ["No subagents have run yet."];
    this.#setPanel({
      kind: "select",
      title: "agents",
      items: nodes,
      selectedIndex: 0,
      scrollOffset: 0,
      note: [
        `active: ${snapshot.subagents.activeCount}`,
        ...treeLines,
      ].join("\n"),
      onChoose: async (item) => {
        this.#pushPanel({
          kind: "text",
          title: item.label,
          lines: item.detailLines.length > 0 ? [...item.detailLines] : ["No additional details."],
          scrollOffset: 0,
        });
        this.#host.requestRender();
      },
    });
    this.#host.requestRender();
  }

  async openPresetPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    const items = snapshot.presets.map((preset) => ({
      id: preset.name,
      label: preset.name,
      detailLines: [
        `description: ${preset.description}`,
        `modelKey: ${preset.modelKey ?? "default"}`,
        `tools: ${joinList(preset.tools)}`,
        `skills: ${joinList(preset.skills)}`,
        `resources: ${joinList(preset.resources)}`,
        `maxIterations: ${preset.maxIterations ?? "default"}`,
      ],
      value: preset.name,
    }));
    this.#setPanel({
      kind: "select",
      title: "preset",
      items,
      selectedIndex: 0,
      scrollOffset: 0,
      note: "Use Up/Down to browse, Esc to close.",
      onChoose: async (item) => {
        this.#pushPanel({
          kind: "text",
          title: item.label,
          lines: item.detailLines.length > 0 ? [...item.detailLines] : ["No additional details."],
          scrollOffset: 0,
        });
        this.#host.requestRender();
      },
    });
    this.#host.requestRender();
  }

  async openSessionsPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    const items = snapshot.sessions.map((session) => ({
      id: session.sessionId,
      label: `${session.sessionId} (${session.state})`,
      detailLines: [
        `updatedAt: ${session.updatedAt}`,
        `lastRunId: ${session.lastRunId ?? "none"}`,
        `lastRunState: ${session.lastRunState ?? "none"}`,
        `title: ${session.title ?? "none"}`,
      ],
      value: session.sessionId,
    }));
    if (items.length === 0) {
      this.#setPanel({
        kind: "text",
        title: "sessions",
        lines: ["No saved sessions."],
        scrollOffset: 0,
      });
      this.#host.requestRender();
      return;
    }
    this.#setPanel({
      kind: "select",
      title: "sessions",
      items,
      selectedIndex: 0,
      scrollOffset: 0,
      note: "Enter resumes the highlighted session.",
      onChoose: async (item) => {
        await this.#switchSession({ sessionId: item.value });
        this.#clearPanels();
        this.#host.requestRender();
      },
    });
    this.#host.requestRender();
  }

  async openModelPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    const modelKeys = snapshot.models.map((model) => model.key);
    if (modelKeys.length === 0) {
      this.#setPanel({
        kind: "text",
        title: "model",
        lines: ["No models are configured."],
        scrollOffset: 0,
      });
      this.#host.requestRender();
      return;
    }
    const items = modelKeys.map((key) => ({
      id: key,
      label: key,
      detailLines: [
        `model key: ${key}`,
      ],
      value: key,
    }));
    this.#setPanel({
      kind: "select",
      title: "model",
      items,
      selectedIndex: 0,
      scrollOffset: 0,
      note: "Enter switches the active model.",
      onChoose: async (item) => {
        await this.#switchSession({ modelKey: item.value });
        this.#clearPanels();
        this.#host.requestRender();
      },
    });
    this.#host.requestRender();
  }

  async openApproval(prompt: ApprovalPrompt): Promise<ApprovalResponse | undefined> {
    return await new Promise<ApprovalResponse | undefined>((resolve) => {
      const items: readonly SelectPanelItem<ApprovalResponse>[] = [
        {
          id: "allow-once",
          label: "Allow once",
          detailLines: ["Execute this tool call one time only."],
          value: { decision: "allow", scope: "once" },
        },
        {
          id: "allow-session",
          label: "Allow for session",
          detailLines: ["Remember this approval for the current session only."],
          value: { decision: "allow", scope: "session" },
        },
        {
          id: "deny",
          label: "Deny",
          detailLines: ["Block this tool call."],
          value: { decision: "deny" },
        },
      ];
      this.#approval = {
        prompt,
        items,
        selectedIndex: 0,
        resolve,
      };
      this.#host.requestRender();
    });
  }

  render(width: number, height?: number): string[] {
    const snapshot = this.#snapshot;
    const activeModel = this.#currentModelKey ?? snapshot?.defaultModel ?? "default";
    const header = this.#showWelcomeBanner
      ? [
          `MingXu | model: ${activeModel} | cwd: ${process.cwd()} | trust: ${snapshot?.projectTrusted ? "trusted" : "untrusted"}`,
        ]
      : [];

    const conversation = this.#renderConversation(width);
    const input = this.#editor.render(width).map((line) => line.replace(/\u001b_pi:c\u0007/gu, ""));
    const footer = this.#renderFooter(snapshot, activeModel, width);
    this.#syncOverlayStack();
    const overlay = this.#overlays.render(width, this.#overlayViewportHeight(height, footer.length, input.length));
    const notice = this.#composerNotice ? [this.#composerNotice] : [];

    const lines = [
      ...header,
      ...(header.length > 0 ? [""] : []),
      ...conversation,
      ...(overlay.length > 0 ? ["", ...overlay, ""] : []),
      ...(footer.length > 0 ? ["", ...footer] : []),
      ...(notice.length > 0 ? ["", ...notice] : []),
      "",
      ...input,
    ];

    return lines;
  }

  prepareFrame(width: number, height: number | undefined, options: { readonly full: boolean }): PreparedRenderFrame {
    const snapshot = this.#snapshot;
    const activeModel = this.#currentModelKey ?? snapshot?.defaultModel ?? "default";
    const showHeader = options.full || this.#showWelcomeBanner;
    const header = showHeader
      ? [`MingXu | model: ${activeModel} | cwd: ${process.cwd()} | trust: ${snapshot?.projectTrusted ? "trusted" : "untrusted"}`]
      : [];
    const conversation = this.#conversation.prepareRender(width, {
      detailed: this.#detailedTranscript,
      theme: this.#transcriptTheme,
    }, options);
    const input = this.#editor.render(width).map((line) => line.replace(/\u001b_pi:c\u0007/gu, ""));
    const footer = this.#renderFooter(snapshot, activeModel, width);
    this.#syncOverlayStack();
    const overlay = this.#overlays.render(width, this.#overlayViewportHeight(height, footer.length, input.length));
    const notice = this.#composerNotice ? [this.#composerNotice] : [];
    const headerSection = header.length > 0 ? [...header, ""] : [];
    const lines = [
      ...headerSection,
      ...conversation.lines,
      ...(overlay.length > 0 ? ["", ...overlay, ""] : []),
      ...(footer.length > 0 ? ["", ...footer] : []),
      ...(notice.length > 0 ? ["", ...notice] : []),
      "",
      ...input,
    ];
    const commitPrefixLineCount = headerSection.length + conversation.commitPrefixLineCount;
    let committed = false;
    return {
      lines,
      commitPrefixLineCount,
      commit: () => {
        if (committed) return;
        committed = true;
        if (showHeader) this.#showWelcomeBanner = false;
        conversation.commit();
      },
    };
  }

  async #refreshSnapshot(): Promise<void> {
    this.#snapshot = await this.#runtime.snapshot();
  }

  async #ensureSnapshot(): Promise<CliRuntimeSnapshot> {
    if (!this.#snapshot) {
      await this.#refreshSnapshot();
    }
    return this.#snapshot as CliRuntimeSnapshot;
  }

  #syncOverlayStack(): void {
    this.#overlays.clear();
    this.#panelStack.forEach((panel, index) => {
      this.#overlays.push({
        id: `panel:${index}:${panel.title}`,
        priority: 20 + index,
        render: (width: number, height?: number) => this.#renderPanel(width, height),
        handleInput: (input: KeyInput) => {
          if (panel.kind === "select") {
            this.#handleSelectPanelInput(input, panel);
          } else {
            this.#handleTextPanelInput(input, panel);
          }
          return { type: "none" };
        },
        invalidate: () => undefined,
      });
    });
    if (this.#approval) {
      const approval = this.#approval;
      this.#overlays.push({
        id: `approval:${approval.prompt.toolCallId}`,
        priority: 100,
        render: (width: number, height?: number) => this.#renderApprovalPanel(width, height),
        handleInput: (input: KeyInput) => {
          this.#handleApprovalInput(input);
          return { type: "none" };
        },
        invalidate: () => undefined,
      });
    }
  }

  #bindSession(session: AgentSession): void {
    this.#sessionSubscription?.();
    this.#sessionSubscription = session.subscribe((event) => {
      void this.#handleAgentEvent(event).catch((error) => this.#handleFatalError(error));
    });
  }

  async #handleAgentEvent(event: AgentEvent): Promise<void> {
    const result = this.#conversation.applyAgentEvent(event);
    this.#running = this.#conversation.state.running;
    if (result.changed) {
      this.#host.requestRender();
    }
  }

  #handleFatalError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#running = false;
    this.#conversation.addError(this.#nextBlockId("error"), "fatal error", redactText(message));
    this.#exitRequested = true;
    const resolve = this.#finishResolver;
    this.#finishResolver = undefined;
    this.#shutdown();
    resolve?.(1);
  }

  #handleKeypress(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void {
    this.#syncOverlayStack();
    if (this.#overlays.top) {
      this.#overlays.handleInput(input);
      return;
    }

    this.handleInput(input);
  }

  #handleApprovalInput(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void {
    const approval = this.#approval;
    if (!approval) return;

    if (input.name === "up") {
      approval.selectedIndex = (approval.selectedIndex - 1 + approval.items.length) % approval.items.length;
      this.#host.requestRender();
      return;
    }
    if (input.name === "down") {
      approval.selectedIndex = (approval.selectedIndex + 1) % approval.items.length;
      this.#host.requestRender();
      return;
    }
    if (input.name === "escape" || (input.ctrl && input.name === "c")) {
      this.#approval = undefined;
      approval.resolve(undefined);
      this.#conversation.addApprovalResult(this.#nextBlockId("approval"), approval.prompt, undefined);
      this.#host.requestRender();
      return;
    }
    if (input.sequence === "1") {
      approval.selectedIndex = 0;
    } else if (input.sequence === "2" && approval.items.length > 1) {
      approval.selectedIndex = 1;
    } else if (input.sequence === "3" && approval.items.length > 2) {
      approval.selectedIndex = 2;
    }

    if (input.name === "enter" || input.name === "return") {
      const item = approval.items[approval.selectedIndex] ?? approval.items[0];
      this.#approval = undefined;
      approval.resolve(item?.value);
      this.#conversation.addApprovalResult(this.#nextBlockId("approval"), approval.prompt, item?.value);
      this.#host.requestRender();
    }
  }

  #handleSelectPanelInput(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }, panel: SelectPanel): void {
    const items = this.#filterPanelItems(panel);
    if (panel.selectedIndex >= items.length) {
      panel.selectedIndex = Math.max(0, items.length - 1);
    }
    if (input.name === "up") {
      if (items.length > 0) {
        panel.selectedIndex = (panel.selectedIndex - 1 + items.length) % items.length;
      }
      this.#host.requestRender();
      return;
    }
    if (input.name === "down") {
      if (items.length > 0) {
        panel.selectedIndex = (panel.selectedIndex + 1) % items.length;
      }
      this.#host.requestRender();
      return;
    }
    if (input.name === "pageup") {
      if (items.length > 0) {
        panel.scrollOffset = Math.max(0, panel.scrollOffset - 5);
        panel.selectedIndex = Math.max(0, panel.selectedIndex - 5);
      }
      this.#host.requestRender();
      return;
    }
    if (input.name === "pagedown") {
      if (items.length > 0) {
        panel.scrollOffset += 5;
        panel.selectedIndex = Math.min(items.length - 1, panel.selectedIndex + 5);
      }
      this.#host.requestRender();
      return;
    }
    if (input.name === "home") {
      panel.selectedIndex = 0;
      panel.scrollOffset = 0;
      this.#host.requestRender();
      return;
    }
    if (input.name === "end") {
      if (items.length > 0) {
        panel.selectedIndex = items.length - 1;
        panel.scrollOffset = Number.MAX_SAFE_INTEGER;
      }
      this.#host.requestRender();
      return;
    }
    if (input.name === "escape" || (input.ctrl && input.name === "c")) {
      this.#popPanel();
      this.#host.requestRender();
      return;
    }
    if (input.name === "enter" || input.name === "return") {
      const item = items[panel.selectedIndex] ?? items[0];
      if (item) {
        void panel.onChoose(item);
      }
      return;
    }
    if (input.name === "backspace") {
      panel.filterText = (panel.filterText ?? "").slice(0, -1);
      panel.selectedIndex = 0;
      this.#host.requestRender();
      return;
    }
    if (input.sequence === "1" && items.length > 0) {
      panel.selectedIndex = 0;
      this.#host.requestRender();
      return;
    }
    if (input.sequence === "2" && items.length > 1) {
      panel.selectedIndex = 1;
      this.#host.requestRender();
      return;
    }
    if (input.sequence === "3" && items.length > 2) {
      panel.selectedIndex = 2;
      this.#host.requestRender();
      return;
    }
    if (input.sequence && !input.ctrl && !input.meta && input.sequence.length === 1) {
      panel.filterText = `${panel.filterText ?? ""}${input.sequence}`;
      panel.selectedIndex = 0;
      panel.scrollOffset = 0;
      this.#host.requestRender();
    }
  }

  #handleTextPanelInput(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }, panel: TextPanel): void {
    if (input.name === "up") {
      panel.scrollOffset = Math.max(0, panel.scrollOffset - 1);
      this.#host.requestRender();
      return;
    }
    if (input.name === "down") {
      panel.scrollOffset += 1;
      this.#host.requestRender();
      return;
    }
    if (input.name === "pageup") {
      panel.scrollOffset = Math.max(0, panel.scrollOffset - 5);
      this.#host.requestRender();
      return;
    }
    if (input.name === "pagedown") {
      panel.scrollOffset += 5;
      this.#host.requestRender();
      return;
    }
    if (input.name === "home") {
      panel.scrollOffset = 0;
      this.#host.requestRender();
      return;
    }
    if (input.name === "end") {
      panel.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.#host.requestRender();
      return;
    }
    if (input.name === "escape" || input.name === "enter" || input.name === "return" || (input.ctrl && input.name === "c")) {
      this.#popPanel();
      this.#host.requestRender();
    }
  }

  async #handleCommand(command: string): Promise<void> {
    const normalized = command.trim().replace(/^\/+/u, "");
    if (!normalized) {
      return;
    }
    this.#composerNotice = undefined;
    const [name, ...rest] = normalized.split(/\s+/u);
    const args = rest.join(" ");

    switch (name) {
      case "help":
      case "?":
        await this.openHelpPanel();
        return;
      case "status":
        await this.openStatusPanel();
        return;
      case "context":
        await this.openContextPanel();
        return;
      case "extensions":
      case "ext":
        await this.openExtensionsPanel();
        return;
      case "agents":
        await this.openAgentsPanel();
        return;
      case "audit":
        await this.openAuditPanel();
        return;
      case "trust":
        await this.openTrustPanel();
        return;
      case "preset":
        await this.openPresetPanel();
        return;
      case "sessions":
        await this.openSessionsPanel();
        return;
      case "session":
        await this.openStatusPanel();
        return;
      case "model":
        if (args) {
          await this.#switchSession({ modelKey: args });
        } else {
          await this.openModelPanel();
        }
        return;
      case "resume":
        if (args) {
          await this.#switchSession({ sessionId: args });
        } else {
          await this.openSessionsPanel();
        }
        return;
      case "new":
        await this.#switchSession({});
        return;
      case "clear":
        this.#conversation.clear();
        this.#conversation.setEmptyHint([
          "No messages yet. Type a prompt or /help.",
          "Try /status, /extensions, or /agents to inspect the runtime.",
        ]);
        this.#showWelcomeBanner = true;
        this.#host.requestRender();
        return;
      case "compact":
        this.#conversation.addStatus(this.#nextBlockId("status"), "compact", ["Conversation compaction is managed by the runtime."]);
        this.#host.requestRender();
        return;
      case "steer":
        if (!args) {
          this.#conversation.addStatus(this.#nextBlockId("status"), "steer", ["Usage: /steer [text]"]);
        } else {
          this.#currentSession.steer(args);
          this.#conversation.addStatus(this.#nextBlockId("status"), "steer", ["Queued steering instruction for the next model turn."]);
        }
        this.#host.requestRender();
        return;
      case "exit":
      case "quit":
        this.exit();
        return;
      default:
        this.#composerNotice = `Unknown command /${name}`;
        this.#host.requestRender();
    }
  }

  async #switchSession(request: CliSessionRequest): Promise<void> {
    if (this.#running) {
      this.#conversation.addError(this.#nextBlockId("error"), "busy", "Wait for the current run to finish before switching session or model.");
      this.#host.requestRender();
      return;
    }

    this.#showWelcomeBanner = false;
    this.#currentSession = this.#runtime.createSession({
      ...(request.modelKey !== undefined ? { modelKey: request.modelKey } : {}),
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      ...(request.preset !== undefined ? { preset: request.preset } : {}),
      interactive: true,
      approvalHandler: (prompt) => this.openApproval(prompt),
    });
    this.#currentModelKey = request.modelKey ?? this.#currentModelKey;
    this.#currentSessionId = request.sessionId ?? this.#currentSessionId;
    this.#conversation.addStatus(this.#nextBlockId("status"), "session switched", [
      `model: ${this.#currentModelKey ?? "default"}`,
      `session: ${this.#currentSessionId ?? "new"}`,
    ]);
    this.#bindSession(this.#currentSession);
    await this.#refreshSnapshot();
    this.#host.requestRender();
  }

  #enqueuePrompt(prompt: string): void {
    if (!prompt.trim()) return;
    if (this.#running) {
      this.#currentSession.followUp(prompt.trim());
      this.#conversation.addStatus(this.#nextBlockId("status"), "queued follow-up", [prompt.trim()]);
      this.#host.requestRender();
      return;
    }
    void this.runPrompt(prompt.trim()).catch(() => undefined);
  }

  #pushStatus(message: string): void {
    this.#conversation.setLastStatus(message);
    this.#host.requestRender();
  }

  #shutdown(): void {
    if (this.#shutdownCompleted) {
      return;
    }
    this.#shutdownCompleted = true;
    this.#host.dispose();
    this.#terminal.showCursor();
    this.#terminal.restore();
    this.#sessionSubscription?.();
    this.#sessionSubscription = undefined;
  }

  #tryFinish(): void {
    if (!this.#exitRequested || this.#running || !this.#finishResolver) {
      return;
    }
    const resolve = this.#finishResolver;
    this.#finishResolver = undefined;
    this.#shutdown();
    resolve(0);
  }

  #pushUserBlock(text: string): void {
    this.#conversation.pushUserMessage(this.#nextBlockId("user"), text);
  }

  #renderConversation(width: number): string[] {
    return this.#conversation.render(width, {
      detailed: this.#detailedTranscript,
      theme: this.#transcriptTheme,
    });
  }

  #overlayViewportHeight(
    height: number | undefined,
    footerLineCount: number,
    inputLineCount: number,
  ): number | undefined {
    if (height === undefined) return undefined;
    return Math.max(6, height - footerLineCount - inputLineCount - 4);
  }

  #renderPanel(width: number, height?: number): string[] {
    const panel = this.#activePanel;
    if (!panel) {
      return [];
    }
    if (panel.kind === "text") {
      return this.#renderTextPanel(panel, width, height);
    }
    return this.#renderSelectPanel(panel, width, height);
  }

  #renderTextPanel(panel: TextPanel, width: number, height?: number): string[] {
    const panelHeight = Math.max(6, (height ?? this.#terminal.size.rows) - 10);
    const bodyLines = panel.lines.flatMap((line) => wrapText(line, Math.max(20, width - 4)));
    const visibleHeight = Math.max(1, panelHeight - 3);
    const maxScroll = Math.max(0, bodyLines.length - visibleHeight);
    panel.scrollOffset = Math.max(0, Math.min(panel.scrollOffset, maxScroll));
    const lines = [
      `title: ${panel.title}`,
      "",
      ...bodyLines.slice(panel.scrollOffset, panel.scrollOffset + visibleHeight),
      "",
      maxScroll > 0
        ? `Scroll ${panel.scrollOffset + 1}-${Math.min(bodyLines.length, panel.scrollOffset + visibleHeight)} of ${bodyLines.length}`
        : "Esc closes",
    ];
    return new Box(new StaticLines(lines.slice(0, panelHeight)), panel.title).render(width);
  }

  #renderSelectPanel(panel: SelectPanel, width: number, height?: number): string[] {
    const items = this.#filterPanelItems(panel);
    const selected = items[panel.selectedIndex] ?? items[0];
    const panelHeight = Math.max(8, (height ?? this.#terminal.size.rows) - 10);
    const noteLines = panel.note ? wrapText(panel.note, Math.max(20, width - 4)) : [];
    const availableListHeight = Math.max(1, panelHeight - noteLines.length - 7);
    const maxScroll = Math.max(0, items.length - availableListHeight);
    panel.scrollOffset = Math.max(0, Math.min(panel.scrollOffset, maxScroll));
    if (panel.selectedIndex < panel.scrollOffset) {
      panel.scrollOffset = panel.selectedIndex;
    } else if (panel.selectedIndex >= panel.scrollOffset + availableListHeight) {
      panel.scrollOffset = Math.max(0, panel.selectedIndex - availableListHeight + 1);
    }
    if (items.length === 0) {
      return new Box(new StaticLines([
        ...noteLines,
        `filter: ${panel.filterText ?? ""}`,
        "",
        "No matching items.",
      ]), panel.title).render(width);
    }
    const listItems = items.slice(panel.scrollOffset, panel.scrollOffset + availableListHeight);
    const list = new SelectList(listItems.map((item) => ({
      id: item.id,
      label: item.label,
      ...(item.detailLines[0] !== undefined ? { description: item.detailLines[0] } : {}),
    })), panel.title);
    for (let index = 0; index < panel.selectedIndex - panel.scrollOffset; index += 1) {
      list.move(1);
    }
    const listLines = [
      ...noteLines,
      `filter: ${panel.filterText ?? ""}`,
      `showing ${panel.scrollOffset + 1}-${Math.min(items.length, panel.scrollOffset + listItems.length)} of ${items.length}`,
      ...list.render(width),
      "",
      ...(selected ? selected.detailLines.flatMap((line) => wrapText(line, Math.max(20, width - 4))) : ["No item selected."]),
      "",
      "Use Up/Down to browse, type to filter, Esc closes.",
    ];
    return new Box(new StaticLines(listLines.slice(0, panelHeight)), panel.title).render(width);
  }

  #filterPanelItems<T>(panel: SelectPanel<T>): readonly SelectPanelItem<T>[] {
    const filter = panel.filterText?.trim().toLowerCase() ?? "";
    if (!filter) {
      return panel.items;
    }
    return panel.items.filter((item) => {
      const haystack = `${item.label}\n${item.detailLines.join("\n")}`.toLowerCase();
      return haystack.includes(filter);
    });
  }

  #renderApprovalPanel(width: number, height?: number): string[] {
    const approval = this.#approval;
    if (!approval) {
      return [];
    }

    const prompt = approval.prompt;
    const items = approval.items.map((item) => ({
      id: item.id,
      label: item.label,
      ...(item.detailLines[0] !== undefined ? { description: item.detailLines[0] } : {}),
    }));
    const selected = approval.items[approval.selectedIndex] ?? approval.items[0];
    const lines = [
      `tool: ${prompt.toolName}`,
      `principal: ${prompt.principalId}`,
      `policy: ${prompt.policyEffect}`,
      `source: ${prompt.source ?? "local"}`,
      `risk: ${prompt.risk ?? "n/a"}`,
      ...(prompt.policyObligations && prompt.policyObligations.length > 0 ? [`obligations: ${prompt.policyObligations.length}`] : []),
      ...(prompt.normalizedResource !== undefined
        ? [`resource: ${prompt.normalizedResource}`]
        : [`resource: ${prompt.resourceScope}`]),
      `action: ${prompt.actionKind}`,
      `reason: ${prompt.reason}`,
      `input: ${formatToolInput(prompt.input)}`,
      "",
      ...new SelectList(items, "approval choices").render(width),
      "",
      ...(selected ? selected.detailLines.flatMap((line) => wrapText(line, Math.max(20, width - 4))) : []),
      "Use Up/Down or 1/2/3, then Enter. Esc denies.",
    ];
    const maxLines = Math.max(6, (height ?? this.#terminal.size.rows) - 2);
    return new Box(new StaticLines(lines.slice(0, maxLines)), "approval").render(width);
  }

  #renderFooter(snapshot: CliRuntimeSnapshot | undefined, activeModel: string, width: number): string[] {
    const context = this.#currentSession.state.messages.length;
    const status = this.#conversation.state.lastStatus;
    const footer = truncateToWidth(`state: ${this.#running ? "streaming" : "idle"} | model: ${activeModel} | ctx: ${context} | ${status}`, width);
    return [footer];
  }

  #nextBlockId(prefix: string): string {
    this.#blockSeq += 1;
    return `${prefix}-${this.#blockSeq}`;
  }
}

class CliTuiScreen implements InlineFrameComponent {
  readonly #app: CliTuiApp;

  constructor(app: CliTuiApp) {
    this.#app = app;
  }

  handleInput(input: KeyInput): void {
    this.#app.handleInput(input);
  }

  invalidate(): void {}

  render(width: number, height?: number): string[] {
    return this.#app.render(width, height);
  }

  prepareFrame(width: number, height: number | undefined, options: { readonly full: boolean }): PreparedRenderFrame {
    return this.#app.prepareFrame(width, height, options);
  }
}

class StaticLines implements Component {
  readonly #lines: readonly string[];

  constructor(lines: readonly string[]) {
    this.#lines = lines;
  }

  handleInput(): void {}

  invalidate(): void {}

  render(width: number): string[] {
    return this.#lines.flatMap((line) => wrapText(line, width));
  }
}

function joinList(values: readonly string[] | undefined): string {
  if (!values || values.length === 0) return "none";
  return values.join(", ");
}

function renderTree(nodes: readonly TreeNode[]): string {
  const lines = new Tree(nodes).render(80);
  return lines.join("\n");
}

function formatToolInput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return inspect(redactValue(value), { depth: 4, breakLength: 100 });
  } catch {
    return String(value);
  }
}
