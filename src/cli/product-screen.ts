import { inspect } from "node:util";

import {
  Box,
  Editor,
  OverlayHost,
  SelectList,
  Tree,
  truncateToWidth,
  type Component,
  type ComponentAction,
  type InlineFrameComponent,
  type KeyInput,
  type PreparedRenderFrame,
  type SelectListItem,
  type TreeNode,
  wrapText,
} from "@mingxu/tui";
import type { ApprovalPrompt, ApprovalResponse } from "../approval/types.js";
import { redactValue } from "../redaction/redactor.js";
import type { SubagentCancelResult } from "../subagents/subagent-manager.js";
import type { CliRuntimeProjection } from "./runtime-projection.js";
import type { CliRuntimeSnapshot, CliSessionRequest } from "./runtime-types.js";
import type { TranscriptTheme } from "./transcript-theme.js";

export interface ProductScreenState {
  readonly snapshot: CliRuntimeSnapshot | undefined;
  readonly sessionId: string | undefined;
  readonly modelKey: string | undefined;
  readonly running: boolean;
  readonly contextMessages: number;
}

export interface ProductScreenOptions {
  readonly projection: CliRuntimeProjection;
  readonly theme: TranscriptTheme;
  readonly terminalRows: () => number;
  readonly state: () => ProductScreenState;
  readonly completions: (value: string) => readonly SelectListItem[];
  readonly requestRender: (options?: { readonly full?: boolean }) => void;
  readonly switchSession: (request: CliSessionRequest) => Promise<boolean>;
  readonly cancelSubagents: (sessionId: string, subtree: boolean) => Promise<SubagentCancelResult | undefined>;
  readonly onApproval: (prompt: ApprovalPrompt, response: ApprovalResponse | undefined) => void;
}

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
  readonly onCancelItem?: (item: SelectPanelItem<T>) => Promise<void> | void;
}

export type ActiveProductPanel = TextPanel | SelectPanel | undefined;

interface PendingApproval {
  readonly prompt: ApprovalPrompt;
  readonly items: readonly SelectPanelItem<ApprovalResponse>[];
  selectedIndex: number;
  readonly resolve: (response: ApprovalResponse | undefined) => void;
}

export class ProductScreen implements InlineFrameComponent {
  readonly #projection: CliRuntimeProjection;
  readonly #theme: TranscriptTheme;
  readonly #terminalRows: () => number;
  readonly #state: () => ProductScreenState;
  readonly #requestRender: ProductScreenOptions["requestRender"];
  readonly #switchSession: ProductScreenOptions["switchSession"];
  readonly #cancelSubagents: ProductScreenOptions["cancelSubagents"];
  readonly #onApproval: ProductScreenOptions["onApproval"];
  readonly #overlays = new OverlayHost();
  readonly editor: Editor;
  #panelStack: NonNullable<ActiveProductPanel>[] = [];
  #activePanel: ActiveProductPanel;
  #approval: PendingApproval | undefined;
  #composerNotice: string | undefined;
  #detailedTranscript = false;
  #showWelcomeBanner = true;

  constructor(options: ProductScreenOptions) {
    this.#projection = options.projection;
    this.#theme = options.theme;
    this.#terminalRows = options.terminalRows;
    this.#state = options.state;
    this.#requestRender = options.requestRender;
    this.#switchSession = options.switchSession;
    this.#cancelSubagents = options.cancelSubagents;
    this.#onApproval = options.onApproval;
    this.editor = new Editor({
      prompt: "> ",
      placeholder: "Ctrl+J inserts a newline",
      completionProvider: options.completions,
    });
  }

  get activePanel(): ActiveProductPanel {
    return this.#activePanel;
  }

  get hasOverlay(): boolean {
    this.#syncOverlayStack();
    return this.#overlays.top !== undefined;
  }

  hideWelcome(): void {
    this.#showWelcomeBanner = false;
  }

  showWelcome(): void {
    this.#showWelcomeBanner = true;
  }

  toggleDetailedTranscript(): boolean {
    this.#detailedTranscript = !this.#detailedTranscript;
    return this.#detailedTranscript;
  }

  setComposerNotice(message: string | undefined): void {
    this.#composerNotice = message;
    this.#requestRender();
  }

  handleOverlayInput(input: KeyInput): boolean {
    this.#syncOverlayStack();
    if (!this.#overlays.top) return false;
    this.#overlays.handleInput(input);
    return true;
  }

  handleEditorInput(input: KeyInput): ComponentAction | void {
    return this.editor.handleInput(input);
  }

  closePendingApproval(): void {
    const approval = this.#approval;
    this.#approval = undefined;
    approval?.resolve(undefined);
  }

  openHelp(lines: readonly string[]): void {
    this.#setPanel({ kind: "text", title: "help", lines, scrollOffset: 0 });
    this.#requestRender();
  }

  openText(title: string, lines: readonly string[]): void {
    this.#setPanel({ kind: "text", title, lines, scrollOffset: 0 });
    this.#requestRender();
  }

  closePanels(): void {
    this.#clearPanels();
    this.#requestRender();
  }

  openStatus(): void {
    const state = this.#state();
    const snapshot = state.snapshot;
    this.#setPanel({
      kind: "text",
      title: "status",
      lines: [
        `session: ${state.sessionId ?? "new"}`,
        `model: ${state.modelKey ?? snapshot?.defaultModel ?? "default"}`,
        `running: ${state.running ? "yes" : "no"}`,
        `messages: ${state.contextMessages}`,
        `panel: ${this.#activePanel?.kind ?? "none"}`,
      ],
      scrollOffset: 0,
    });
    this.#requestRender();
  }

  openContext(): void {
    const state = this.#state();
    const snapshot = state.snapshot;
    if (!snapshot) return;
    this.#setPanel({
      kind: "text",
      title: "context",
      lines: [
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
        `message budget: ${state.contextMessages}`,
      ],
      scrollOffset: 0,
    });
    this.#requestRender();
  }

  openAudit(): void {
    const snapshot = this.#state().snapshot;
    if (!snapshot) return;
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
    this.#requestRender();
  }

  openTrust(): void {
    const snapshot = this.#state().snapshot;
    if (!snapshot) return;
    this.#setPanel({
      kind: "text",
      title: "trust",
      lines: [`projectTrusted: ${snapshot.projectTrusted}`, ...snapshot.configSources.map((source) => `${source.kind}: ${source.path}`)],
      scrollOffset: 0,
    });
    this.#requestRender();
  }

  openExtensions(): void {
    const snapshot = this.#state().snapshot;
    if (!snapshot) return;
    const items: SelectPanelItem[] = [
      ...snapshot.extensions.map((extension) => ({
        id: `extension:${extension.id}`,
        label: `${extension.id} (${extension.enabled ? "enabled" : "disabled"})`,
        detailLines: [
          `name: ${extension.name}`, `version: ${extension.version}`, `adapter: ${extension.adapterId}`,
          `scope: ${extension.scope}`, `health: ${extension.health}`,
          `source: ${extension.source.kind}:${extension.source.locator}`, `entry: ${extension.entryPath}`,
          `permissions: ${extension.permissions ? JSON.stringify(extension.permissions) : "none"}`,
        ],
        value: extension.id,
      })),
      ...snapshot.presets.map((preset) => ({
        id: `preset:${preset.name}`,
        label: `preset ${preset.name}`,
        detailLines: [
          `description: ${preset.description}`, `modelKey: ${preset.modelKey ?? "default"}`,
          `skills: ${joinList(preset.skills)}`, `resources: ${joinList(preset.resources)}`,
          `tools: ${joinList(preset.tools)}`, `maxIterations: ${preset.maxIterations ?? "default"}`,
        ],
        value: preset.name,
      })),
      ...snapshot.skills.map((skill) => ({
        id: `skill:${skill.name}`,
        label: `skill ${skill.name}`,
        detailLines: [`version: ${skill.version}`, `description: ${skill.description}`, `entry: ${skill.entryPath}`, `visibility: ${skill.visibility}`],
        value: skill.name,
      })),
      ...snapshot.resources.map((resource) => ({
        id: `resource:${resource.kind}:${resource.name}`,
        label: `${resource.kind} ${resource.name}`,
        detailLines: [
          `visibility: ${resource.visibility}`, `source: ${resource.source ?? "local_file"}`,
          `path: ${resource.path ?? "inline"}`, `description: ${resource.description ?? "none"}`,
        ],
        value: resource.name,
      })),
      ...snapshot.mcpServers.map((server) => ({
        id: `mcp:${server.name}`,
        label: `mcp ${server.name}`,
        detailLines: [`transport: ${server.transport}`, `connected: ${server.connected}`],
        value: server.name,
      })),
    ];
    this.#openBrowsePanel("extensions", items, "Use Up/Down to browse, Esc to close.");
  }

  openAgents(): void {
    const snapshot = this.#state().snapshot;
    if (!snapshot) return;
    const items = snapshot.subagents.nodes.map((node) => ({
      id: node.id,
      label: `${node.sessionId} (${node.state})`,
      detailLines: [
        `preset: ${node.presetName}`, `depth: ${node.depth}`, `sessionId: ${node.sessionId}`,
        `parentSessionId: ${node.parentSessionId ?? "none"}`, `parentRunId: ${node.parentRunId ?? "none"}`,
        `startedAt: ${node.startedAt}`, `endedAt: ${node.endedAt ?? "running"}`,
        `terminationReason: ${node.terminationReason ?? "n/a"}`,
        `content: ${node.content ? truncateToWidth(node.content, 120) : "none"}`,
        `error: ${node.error ?? "none"}`, `cancellationReason: ${node.cancellationReason ?? "none"}`,
        `cancellationError: ${node.cancellationError ?? "none"}`,
      ],
      value: node.id,
    }));
    const treeLines = snapshot.subagents.tree.length > 0 ? [renderTree(snapshot.subagents.tree)] : ["No subagents have run yet."];
    this.#setPanel({
      kind: "select",
      title: "agents",
      items,
      selectedIndex: 0,
      scrollOffset: 0,
      note: [`active: ${snapshot.subagents.activeCount}`, ...treeLines, "Press x or Delete to cancel a node or subtree."].join("\n"),
      onChoose: (item) => this.#openDetails(item),
      onCancelItem: (item) => this.#openAgentCancellation(item.value),
    });
    this.#requestRender();
  }

  openPresets(): void {
    const snapshot = this.#state().snapshot;
    if (!snapshot) return;
    this.#openBrowsePanel("preset", snapshot.presets.map((preset) => ({
      id: preset.name,
      label: preset.name,
      detailLines: [
        `description: ${preset.description}`, `modelKey: ${preset.modelKey ?? "default"}`,
        `tools: ${joinList(preset.tools)}`, `skills: ${joinList(preset.skills)}`,
        `resources: ${joinList(preset.resources)}`, `maxIterations: ${preset.maxIterations ?? "default"}`,
      ],
      value: preset.name,
    })), "Use Up/Down to browse, Esc to close.");
  }

  openSessions(): void {
    const snapshot = this.#state().snapshot;
    if (!snapshot) return;
    this.#setPanel({
      kind: "select",
      title: "sessions",
      items: snapshot.sessions.map((session) => ({
        id: session.sessionId,
        label: `${session.sessionId} (${session.state})`,
        detailLines: [
          `updatedAt: ${session.updatedAt}`, `lastRunId: ${session.lastRunId ?? "none"}`,
          `lastRunState: ${session.lastRunState ?? "none"}`, `title: ${session.title ?? "none"}`,
        ],
        value: session.sessionId,
      })),
      selectedIndex: 0,
      scrollOffset: 0,
      note: "Enter resumes the selected session.",
      onChoose: async (item) => {
        if (await this.#switchSession({ sessionId: item.value })) this.#clearPanels();
        this.#requestRender();
      },
    });
    this.#requestRender();
  }

  openModels(): void {
    const snapshot = this.#state().snapshot;
    if (!snapshot) return;
    this.#setPanel({
      kind: "select",
      title: "model",
      items: snapshot.models.map((model) => ({
        id: model.key,
        label: model.key,
        detailLines: [`provider: ${model.provider}`, `model: ${model.model}`],
        value: model.key,
      })),
      selectedIndex: 0,
      scrollOffset: 0,
      note: "Enter switches the active model.",
      onChoose: async (item) => {
        if (await this.#switchSession({ modelKey: item.value })) this.#clearPanels();
        this.#requestRender();
      },
    });
    this.#requestRender();
  }

  async openApproval(prompt: ApprovalPrompt): Promise<ApprovalResponse | undefined> {
    return await new Promise<ApprovalResponse | undefined>((resolve) => {
      this.#approval = {
        prompt,
        items: [
          { id: "allow-once", label: "Allow once", detailLines: ["Execute this tool call one time only."], value: { decision: "allow", scope: "once" } },
          { id: "allow-session", label: "Allow for session", detailLines: ["Remember this approval for the current session only."], value: { decision: "allow", scope: "session" } },
          { id: "deny", label: "Deny", detailLines: ["Block this tool call."], value: { decision: "deny" } },
        ],
        selectedIndex: 0,
        resolve,
      };
      this.#requestRender();
    });
  }

  invalidate(): void {}

  render(width: number, height?: number): string[] {
    const state = this.#state();
    const activeModel = state.modelKey ?? state.snapshot?.defaultModel ?? "default";
    const header = this.#showWelcomeBanner
      ? [`MingXu | model: ${activeModel} | cwd: ${process.cwd()} | trust: ${state.snapshot?.projectTrusted ? "trusted" : "untrusted"}`]
      : [];
    const conversation = this.#projection.render(width, { detailed: this.#detailedTranscript, theme: this.#theme });
    const input = this.#inputLines(width);
    const footer = this.#renderFooter(activeModel, width);
    this.#syncOverlayStack();
    const overlay = this.#overlays.render(width, this.#overlayViewportHeight(height, footer.length, input.length));
    const notice = this.#composerNotice ? [this.#composerNotice] : [];
    return [
      ...header, ...(header.length > 0 ? [""] : []), ...conversation,
      ...(overlay.length > 0 ? ["", ...overlay, ""] : []),
      ...(footer.length > 0 ? ["", ...footer] : []),
      ...(notice.length > 0 ? ["", ...notice] : []), "", ...input,
    ];
  }

  prepareFrame(width: number, height: number | undefined, options: { readonly full: boolean }): PreparedRenderFrame {
    const state = this.#state();
    const activeModel = state.modelKey ?? state.snapshot?.defaultModel ?? "default";
    const showHeader = options.full || this.#showWelcomeBanner;
    const header = showHeader
      ? [`MingXu | model: ${activeModel} | cwd: ${process.cwd()} | trust: ${state.snapshot?.projectTrusted ? "trusted" : "untrusted"}`]
      : [];
    const conversation = this.#projection.prepareRender(width, { detailed: this.#detailedTranscript, theme: this.#theme }, options);
    const input = this.#inputLines(width);
    const footer = this.#renderFooter(activeModel, width);
    this.#syncOverlayStack();
    const overlay = this.#overlays.render(width, this.#overlayViewportHeight(height, footer.length, input.length));
    const notice = this.#composerNotice ? [this.#composerNotice] : [];
    const headerSection = header.length > 0 ? [...header, ""] : [];
    const lines = [
      ...headerSection, ...conversation.lines,
      ...(overlay.length > 0 ? ["", ...overlay, ""] : []),
      ...(footer.length > 0 ? ["", ...footer] : []),
      ...(notice.length > 0 ? ["", ...notice] : []), "", ...input,
    ];
    let committed = false;
    return {
      lines,
      commitPrefixLineCount: headerSection.length + conversation.commitPrefixLineCount,
      commit: () => {
        if (committed) return;
        committed = true;
        if (showHeader) this.#showWelcomeBanner = false;
        conversation.commit();
      },
    };
  }

  #openBrowsePanel(title: string, items: readonly SelectPanelItem[], note: string): void {
    this.#setPanel({
      kind: "select", title, items, selectedIndex: 0, scrollOffset: 0, note,
      onChoose: (item) => this.#openDetails(item),
    });
    this.#requestRender();
  }

  #openDetails(item: SelectPanelItem): void {
    this.#pushPanel({ kind: "text", title: item.label, lines: item.detailLines.length > 0 ? [...item.detailLines] : ["No additional details."], scrollOffset: 0 });
    this.#requestRender();
  }

  #openAgentCancellation(sessionId: string): void {
    this.#pushPanel({
      kind: "select",
      title: "cancel agent",
      items: [
        { id: "node", label: "Cancel this node", detailLines: [`Target: ${sessionId}`], value: "node" },
        { id: "subtree", label: "Cancel node and subtree", detailLines: [`Target: ${sessionId} and all descendants`], value: "subtree" },
      ],
      selectedIndex: 0,
      scrollOffset: 0,
      note: "Select a scope and press Enter to confirm. Esc keeps the agent running.",
      onChoose: async (item) => {
        const result = await this.#cancelSubagents(sessionId, item.value === "subtree");
        const lines = result
          ? [`result: ${result.status}`, `scope: ${result.scope}`, ...result.targets.map((target) => `${target.sessionId}: ${target.status} - ${target.reason}`)]
          : ["Cancellation is unavailable in this runtime."];
        this.#popPanel();
        this.#pushPanel({ kind: "text", title: "cancel result", lines, scrollOffset: 0 });
        this.#requestRender();
      },
    });
    this.#requestRender();
  }

  #setPanel(panel: ActiveProductPanel): void {
    this.#panelStack = panel ? [panel] : [];
    this.#activePanel = panel;
  }

  #pushPanel(panel: NonNullable<ActiveProductPanel>): void {
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

  #syncOverlayStack(): void {
    this.#overlays.clear();
    this.#panelStack.forEach((panel, index) => {
      this.#overlays.push({
        id: `panel:${index}:${panel.title}`,
        priority: 20 + index,
        render: (width, height) => this.#renderPanel(width, height),
        handleInput: (input) => {
          if (panel.kind === "select") this.#handleSelectPanelInput(input, panel);
          else this.#handleTextPanelInput(input, panel);
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
        render: (width, height) => this.#renderApprovalPanel(width, height),
        handleInput: (input) => { this.#handleApprovalInput(input); return { type: "none" }; },
        invalidate: () => undefined,
      });
    }
  }

  #handleApprovalInput(input: KeyInput): void {
    const approval = this.#approval;
    if (!approval) return;
    if (input.name === "up") approval.selectedIndex = (approval.selectedIndex - 1 + approval.items.length) % approval.items.length;
    else if (input.name === "down") approval.selectedIndex = (approval.selectedIndex + 1) % approval.items.length;
    else if (input.name === "escape" || (input.ctrl && input.name === "c")) {
      this.#approval = undefined;
      approval.resolve(undefined);
      this.#onApproval(approval.prompt, undefined);
    } else {
      if (input.sequence === "1") approval.selectedIndex = 0;
      else if (input.sequence === "2" && approval.items.length > 1) approval.selectedIndex = 1;
      else if (input.sequence === "3" && approval.items.length > 2) approval.selectedIndex = 2;
      if (input.name === "enter" || input.name === "return") {
        const item = approval.items[approval.selectedIndex] ?? approval.items[0];
        this.#approval = undefined;
        approval.resolve(item?.value);
        this.#onApproval(approval.prompt, item?.value);
      }
    }
    this.#requestRender();
  }

  #handleSelectPanelInput(input: KeyInput, panel: SelectPanel): void {
    const items = this.#filterPanelItems(panel);
    panel.selectedIndex = Math.min(panel.selectedIndex, Math.max(0, items.length - 1));
    if (input.name === "up" && items.length > 0) panel.selectedIndex = (panel.selectedIndex - 1 + items.length) % items.length;
    else if (input.name === "down" && items.length > 0) panel.selectedIndex = (panel.selectedIndex + 1) % items.length;
    else if (input.name === "pageup" && items.length > 0) panel.selectedIndex = Math.max(0, panel.selectedIndex - 5);
    else if (input.name === "pagedown" && items.length > 0) panel.selectedIndex = Math.min(items.length - 1, panel.selectedIndex + 5);
    else if (input.name === "home") { panel.selectedIndex = 0; panel.scrollOffset = 0; }
    else if (input.name === "end" && items.length > 0) { panel.selectedIndex = items.length - 1; panel.scrollOffset = Number.MAX_SAFE_INTEGER; }
    else if (input.name === "escape" || (input.ctrl && input.name === "c")) this.#popPanel();
    else if ((input.sequence === "x" || input.name === "delete") && panel.onCancelItem) {
      const item = items[panel.selectedIndex] ?? items[0];
      if (item) void panel.onCancelItem(item);
    } else if (input.name === "enter" || input.name === "return") {
      const item = items[panel.selectedIndex] ?? items[0];
      if (item) void panel.onChoose(item);
    } else if (input.name === "backspace") {
      panel.filterText = (panel.filterText ?? "").slice(0, -1); panel.selectedIndex = 0; panel.scrollOffset = 0;
    } else if (input.sequence && !input.ctrl && !input.meta && input.sequence.length === 1) {
      panel.filterText = `${panel.filterText ?? ""}${input.sequence}`; panel.selectedIndex = 0; panel.scrollOffset = 0;
    }
    this.#requestRender();
  }

  #handleTextPanelInput(input: KeyInput, panel: TextPanel): void {
    if (input.name === "up") panel.scrollOffset = Math.max(0, panel.scrollOffset - 1);
    else if (input.name === "down") panel.scrollOffset += 1;
    else if (input.name === "pageup") panel.scrollOffset = Math.max(0, panel.scrollOffset - 5);
    else if (input.name === "pagedown") panel.scrollOffset += 5;
    else if (input.name === "home") panel.scrollOffset = 0;
    else if (input.name === "end") panel.scrollOffset = Number.MAX_SAFE_INTEGER;
    else if (input.name === "escape" || input.name === "enter" || input.name === "return" || (input.ctrl && input.name === "c")) this.#popPanel();
    this.#requestRender();
  }

  #renderPanel(width: number, height?: number): string[] {
    const panel = this.#activePanel;
    if (!panel) return [];
    return panel.kind === "text" ? this.#renderTextPanel(panel, width, height) : this.#renderSelectPanel(panel, width, height);
  }

  #renderTextPanel(panel: TextPanel, width: number, height?: number): string[] {
    const panelHeight = Math.max(3, height ?? this.#terminalRows() - 10);
    const innerHeight = Math.max(1, panelHeight - 2);
    const bodyLines = panel.lines.flatMap((line) => wrapText(line, Math.max(1, width - 4)));
    const visibleHeight = Math.max(1, innerHeight - 2);
    const maxScroll = Math.max(0, bodyLines.length - visibleHeight);
    panel.scrollOffset = Math.max(0, Math.min(panel.scrollOffset, maxScroll));
    const lines = [
      ...bodyLines.slice(panel.scrollOffset, panel.scrollOffset + visibleHeight),
      maxScroll > 0 ? `Scroll ${panel.scrollOffset + 1}-${Math.min(bodyLines.length, panel.scrollOffset + visibleHeight)} of ${bodyLines.length}` : "Esc closes",
    ];
    return new Box(new StaticLines(lines.slice(0, innerHeight)), panel.title).render(width);
  }

  #renderSelectPanel(panel: SelectPanel, width: number, height?: number): string[] {
    const items = this.#filterPanelItems(panel);
    const selected = items[panel.selectedIndex] ?? items[0];
    const panelHeight = Math.max(3, height ?? this.#terminalRows() - 10);
    const innerHeight = Math.max(1, panelHeight - 2);
    const allNoteLines = panel.note ? wrapText(panel.note, Math.max(1, width - 4)) : [];
    const noteLines = allNoteLines.slice(0, Math.max(0, innerHeight - 3));
    const chromeHeight = noteLines.length + (innerHeight >= 4 ? 2 : 0);
    const availableListHeight = Math.max(1, innerHeight - chromeHeight);
    const maxScroll = Math.max(0, items.length - availableListHeight);
    panel.scrollOffset = Math.max(0, Math.min(panel.scrollOffset, maxScroll));
    if (panel.selectedIndex < panel.scrollOffset) panel.scrollOffset = panel.selectedIndex;
    else if (panel.selectedIndex >= panel.scrollOffset + availableListHeight) panel.scrollOffset = Math.max(0, panel.selectedIndex - availableListHeight + 1);
    if (items.length === 0) {
      return new Box(new StaticLines([...noteLines, `filter: ${panel.filterText ?? ""}`, "No matching items."].slice(0, innerHeight)), panel.title).render(width);
    }
    const listItems = items.slice(panel.scrollOffset, panel.scrollOffset + availableListHeight);
    const list = new SelectList(listItems.map((item) => ({
      id: item.id, label: item.label, ...(item.detailLines[0] !== undefined ? { description: item.detailLines[0] } : {}),
    })));
    for (let index = 0; index < panel.selectedIndex - panel.scrollOffset; index += 1) list.move(1);
    const listLines = [
      ...noteLines,
      ...(innerHeight >= 4 ? [`filter: ${panel.filterText ?? ""}`, `showing ${panel.scrollOffset + 1}-${Math.min(items.length, panel.scrollOffset + listItems.length)} of ${items.length}`] : []),
      ...list.render(width),
    ];
    if (listLines.length < innerHeight && selected) listLines.push(...selected.detailLines.flatMap((line) => wrapText(line, Math.max(1, width - 4))));
    return new Box(new StaticLines(listLines.slice(0, innerHeight)), panel.title).render(width);
  }

  #renderApprovalPanel(width: number, height?: number): string[] {
    const approval = this.#approval;
    if (!approval) return [];
    const prompt = approval.prompt;
    const selected = approval.items[approval.selectedIndex] ?? approval.items[0];
    const list = new SelectList(approval.items.map((item) => ({
      id: item.id,
      label: item.label,
      ...(item.detailLines[0] !== undefined ? { description: item.detailLines[0] } : {}),
    })));
    for (let index = 0; index < approval.selectedIndex; index += 1) list.move(1);
    const lines = [
      `tool: ${prompt.toolName}`, `principal: ${prompt.principalId}`, `policy: ${prompt.policyEffect}`,
      `source: ${prompt.source ?? "local"}`, `risk: ${prompt.risk ?? "n/a"}`,
      `resource: ${prompt.normalizedResource ?? prompt.resourceScope}`, `action: ${prompt.actionKind}`,
      `reason: ${prompt.reason}`, `input: ${formatToolInput(prompt.input)}`, "", ...list.render(width), "",
      ...(selected ? selected.detailLines : []), "Use Up/Down or 1/2/3, then Enter. Esc denies.",
    ];
    const maxLines = Math.max(3, height ?? this.#terminalRows() - 2);
    return new Box(new StaticLines(lines.slice(0, Math.max(1, maxLines - 2))), "approval").render(width);
  }

  #filterPanelItems<T>(panel: SelectPanel<T>): readonly SelectPanelItem<T>[] {
    const filter = panel.filterText?.trim().toLowerCase() ?? "";
    if (!filter) return panel.items;
    return panel.items.filter((item) => `${item.label}\n${item.detailLines.join("\n")}`.toLowerCase().includes(filter));
  }

  #inputLines(width: number): string[] {
    return this.editor.render(width).map((line) => line.replace(/\u001b_pi:c\u0007/gu, ""));
  }

  #renderFooter(activeModel: string, width: number): string[] {
    const state = this.#state();
    return [truncateToWidth(`state: ${state.running ? "streaming" : "idle"} | model: ${activeModel} | ctx: ${state.contextMessages} | ${this.#projection.state.lastStatus}`, width)];
  }

  #overlayViewportHeight(height: number | undefined, footerLines: number, inputLines: number): number | undefined {
    return height === undefined ? undefined : Math.max(3, height - footerLines - inputLines - 4);
  }
}

class StaticLines implements Component {
  constructor(readonly lines: readonly string[]) {}
  invalidate(): void {}
  render(width: number): string[] { return this.lines.flatMap((line) => wrapText(line, width)); }
}

function joinList(values: readonly string[] | undefined): string {
  return !values || values.length === 0 ? "none" : values.join(", ");
}

function renderTree(nodes: readonly TreeNode[]): string {
  return new Tree(nodes).render(80).join("\n");
}

function formatToolInput(value: unknown): string {
  if (typeof value === "string") return value;
  try { return inspect(redactValue(value), { depth: 4, breakLength: 100 }); }
  catch { return String(value); }
}
