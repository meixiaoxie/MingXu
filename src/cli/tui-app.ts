import { inspect } from "node:util";

import { AgentSession } from "../core/agent-session.js";
import type { AgentEvent } from "../events/types.js";
import type { ApprovalPrompt, ApprovalResponse, ApprovalResponseScope } from "../approval/types.js";
import { ProcessTerminal } from "../tui/terminal.js";
import { TuiHost } from "../tui/host.js";
import {
  Box,
  Editor,
  KeyValue,
  Markdown,
  SelectList,
  Table,
  Text,
  Tree,
  type SelectListItem,
  type TreeNode,
} from "../tui/components.js";
import { truncateToWidth, visibleWidth, wrapText } from "../tui/strings.js";
import type { KeyInput, Component } from "../tui/types.js";
import type { CliRuntimeContext, CliRuntimeSnapshot, CliSessionRequest } from "./runtime-types.js";
import { formatChatHelp, suggestChatCommands } from "./chat-commands.js";
import { redactText, redactValue } from "../redaction/redactor.js";

interface ConversationBlock {
  readonly id: string;
  readonly kind: "user" | "assistant" | "tool" | "status" | "error";
  title: string;
  text?: string;
  lines: string[];
  live?: boolean;
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
}

interface SelectPanel<T = string> {
  readonly kind: "select";
  readonly title: string;
  readonly items: readonly SelectPanelItem<T>[];
  selectedIndex: number;
  readonly note?: string;
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
  readonly #messages: ConversationBlock[] = [];
  #snapshot: CliRuntimeSnapshot | undefined;
  #currentSession: AgentSession;
  #currentSessionId: string | undefined;
  #currentModelKey: string | undefined;
  #running = false;
  #exitRequested = false;
  #activePanel: ActivePanel = undefined;
  #approval: PendingApproval | undefined;
  #sessionSubscription: (() => void) | undefined;
  #currentAssistantBlockId: string | undefined;
  #currentToolBlocks = new Map<string, ConversationBlock>();
  #lastStatus = "Idle";
  #finishResolver: ((exitCode: number) => void) | undefined;

  constructor(options: {
    runtime: CliRuntimeContext;
    terminal: ProcessTerminal;
    session: AgentSession;
    modelKey?: string;
    sessionId?: string;
  }) {
    this.#runtime = options.runtime;
    this.#terminal = options.terminal;
    this.#currentSession = options.session;
    this.#currentSessionId = options.sessionId;
    this.#currentModelKey = options.modelKey;
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
    await this.#refreshSnapshot();
    if (!this.#currentModelKey && this.#snapshot) {
      this.#currentModelKey = this.#snapshot.defaultModel;
    }
    this.#bindSession(this.#currentSession);
    this.#terminal.enterRawMode();
    this.#terminal.hideCursor();
    this.#terminal.onKeypress((input) => this.#handleKeypress(input));
    this.#terminal.onResize(() => this.#host.requestRender());
    this.#host.requestRender();

    if (initialPrompt?.trim()) {
      this.#enqueuePrompt(initialPrompt.trim());
    }

    return await new Promise<number>((resolve) => {
      this.#finishResolver = resolve;
      this.#exitRequested = false;
      this.#tryFinish();
    });
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

  get activePanel(): ActivePanel {
    return this.#activePanel;
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
      this.#messages.push({
        id: `queued-${Date.now()}`,
        kind: "status",
        title: "queued follow-up",
        lines: [`${cleaned}`],
      });
      this.#host.requestRender();
      return;
    }

    this.#running = true;
    this.#pushUserBlock(cleaned);
    this.#host.requestRender();

    try {
      const result = await this.#currentSession.prompt(cleaned);
      this.#currentSessionId = result.sessionId ?? this.#currentSessionId;
      this.#pushStatus(`${result.terminationReason}${result.usage ? ` · ${result.usage.totalTokens ?? 0} tokens` : ""}`);
      this.#messages.push({
        id: `result-${Date.now()}`,
        kind: "status",
        title: "run result",
        lines: [
          `termination: ${result.terminationReason}`,
          ...(result.usage !== undefined
            ? [
                `inputTokens: ${result.usage.inputTokens}`,
                `outputTokens: ${result.usage.outputTokens}`,
                `totalTokens: ${result.usage.totalTokens}`,
                `modelRequests: ${result.usage.modelRequests}`,
              ]
            : []),
        ],
      });
    } catch (error) {
      this.#pushStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
      this.#messages.push({
        id: `error-${Date.now()}`,
        kind: "error",
        title: "run error",
        lines: [redactText(error instanceof Error ? error.message : String(error))],
      });
      throw error;
    } finally {
      this.#running = false;
      this.#currentAssistantBlockId = undefined;
      this.#currentToolBlocks.clear();
      await this.#refreshSnapshot();
      this.#host.requestRender();
      this.#tryFinish();
    }
  }

  async handleSubmit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      await this.#handleCommand(trimmed);
      return;
    }
    await this.runPrompt(trimmed);
  }

  handleInput(input: KeyInput): void {
    if (this.#approval) {
      this.#handleApprovalInput(input);
      return;
    }

    if (this.#activePanel?.kind === "select") {
      this.#handleSelectPanelInput(input, this.#activePanel);
      return;
    }

    if (this.#activePanel?.kind === "text") {
      if (input.name === "escape" || input.name === "return" || input.name === "enter" || input.ctrl && input.name === "c") {
        this.#activePanel = undefined;
        this.#host.requestRender();
      }
      return;
    }

    if (input.ctrl && input.name === "c") {
      if (this.#running) {
        this.#currentSession.abort("Interrupted by user");
        this.#pushStatus("Run aborted");
        this.#host.requestRender();
        return;
      }
      this.exit();
      return;
    }

    if (input.ctrl && input.name === "d") {
      this.exit();
      return;
    }

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
    this.#activePanel = {
      kind: "text",
      title: "help",
      lines: formatChatHelp().split("\n"),
    };
    this.#host.requestRender();
  }

  async openStatusPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    this.#activePanel = {
      kind: "text",
      title: "status",
      lines: [
        `session: ${this.#currentSessionId ?? "new"}`,
        `model: ${this.#currentModelKey ?? snapshot.defaultModel}`,
        `running: ${this.#running ? "yes" : "no"}`,
        `tools: ${(this.#currentSession.state.tools ?? []).length}`,
        `panel: ${this.#activePanel?.kind ?? "none"}`,
      ],
    };
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
    this.#activePanel = { kind: "text", title: "context", lines };
    this.#host.requestRender();
  }

  async openAuditPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    this.#activePanel = {
      kind: "text",
      title: "audit",
      lines: [
        `enabled: ${snapshot.audit.enabled}`,
        `file: ${snapshot.audit.file ?? "none"}`,
        `healthy: ${snapshot.audit.healthy}`,
        `failClosedForHighRisk: ${snapshot.audit.failClosedForHighRisk}`,
      ],
    };
    this.#host.requestRender();
  }

  async openTrustPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    this.#activePanel = {
      kind: "text",
      title: "trust",
      lines: [
        `projectTrusted: ${snapshot.projectTrusted}`,
        ...snapshot.configSources.map((source) => `${source.kind}: ${source.path}`),
      ],
    };
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

    this.#activePanel = {
      kind: "select",
      title: "extensions",
      items,
      selectedIndex: 0,
      note: "Use Up/Down to browse, Esc to close.",
      onChoose: async (item) => {
        this.#activePanel = {
          kind: "text",
          title: item.label,
          lines: item.detailLines.length > 0 ? [...item.detailLines] : ["No additional details."],
        };
        this.#host.requestRender();
      },
    };
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
    this.#activePanel = {
      kind: "select",
      title: "agents",
      items: nodes,
      selectedIndex: 0,
      note: [
        `active: ${snapshot.subagents.activeCount}`,
        ...treeLines,
      ].join("\n"),
      onChoose: async (item) => {
        this.#activePanel = {
          kind: "text",
          title: item.label,
          lines: item.detailLines.length > 0 ? [...item.detailLines] : ["No additional details."],
        };
        this.#host.requestRender();
      },
    };
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
    this.#activePanel = {
      kind: "select",
      title: "preset",
      items,
      selectedIndex: 0,
      note: "Use Up/Down to browse, Esc to close.",
      onChoose: async (item) => {
        this.#activePanel = {
          kind: "text",
          title: item.label,
          lines: item.detailLines.length > 0 ? [...item.detailLines] : ["No additional details."],
        };
        this.#host.requestRender();
      },
    };
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
      this.#activePanel = {
        kind: "text",
        title: "sessions",
        lines: ["No saved sessions."],
      };
      this.#host.requestRender();
      return;
    }
    this.#activePanel = {
      kind: "select",
      title: "sessions",
      items,
      selectedIndex: 0,
      note: "Enter resumes the highlighted session.",
      onChoose: async (item) => {
        await this.#switchSession({ sessionId: item.value });
        this.#activePanel = undefined;
        this.#host.requestRender();
      },
    };
    this.#host.requestRender();
  }

  async openModelPanel(): Promise<void> {
    const snapshot = await this.#ensureSnapshot();
    const modelKeys = snapshot.models.map((model) => model.key);
    if (modelKeys.length === 0) {
      this.#activePanel = {
        kind: "text",
        title: "model",
        lines: ["No models are configured."],
      };
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
    this.#activePanel = {
      kind: "select",
      title: "model",
      items,
      selectedIndex: 0,
      note: "Enter switches the active model.",
      onChoose: async (item) => {
        await this.#switchSession({ modelKey: item.value });
        this.#activePanel = undefined;
        this.#host.requestRender();
      },
    };
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

  render(width: number): string[] {
    const snapshot = this.#snapshot;
    const activeModel = this.#currentModelKey ?? snapshot?.defaultModel ?? "default";
    const header = [
      `MingXu | session: ${this.#currentSessionId ?? "new"} | model: ${activeModel} | state: ${this.#running ? "streaming" : "idle"}${this.#activePanel ? ` | panel: ${this.#activePanel.title}` : ""}`,
      `audit: ${snapshot?.audit.enabled ? (snapshot.audit.healthy ? "healthy" : "unhealthy") : "disabled"} | trust: ${snapshot?.projectTrusted ? "trusted" : "untrusted"} | tools: ${(this.#currentSession.state.tools ?? []).length}`,
    ];

    const conversation = this.#renderConversation(width);
    const input = this.#editor.render(width).map((line) => line.replace(/\u001b_pi:c\u0007/gu, ""));
    const panel = this.#renderPanel(width);

    const lines = [
      ...header,
      "",
      ...conversation,
      ...(panel.length > 0 ? ["", ...panel, ""] : [""]),
      ...input,
    ];

    const maxRows = this.#terminal.size.rows || 24;
    if (lines.length <= maxRows) {
      return lines;
    }

    const tail = lines.slice(Math.max(0, lines.length - maxRows));
    return tail;
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

  #bindSession(session: AgentSession): void {
    this.#sessionSubscription?.();
    this.#sessionSubscription = session.subscribe((event) => {
      void this.#handleAgentEvent(event);
    });
  }

  async #handleAgentEvent(event: AgentEvent): Promise<void> {
    if (event.type === "agent_start") {
      this.#running = true;
      this.#pushStatus("Run started");
      this.#host.requestRender();
      return;
    }

    if (event.type === "turn_start") {
      return;
    }

    if (event.type === "message_start") {
      if (event.message.role === "assistant") {
        this.#currentAssistantBlockId = `assistant-${Date.now()}`;
        this.#messages.push({
          id: this.#currentAssistantBlockId,
          kind: "assistant",
          title: "assistant",
          text: "",
          lines: [],
          live: true,
        });
      }
      if (event.message.role === "user") {
        this.#messages.push({
          id: `user-${Date.now()}`,
          kind: "user",
          title: "user",
          lines: [event.message.content],
        });
      }
      this.#host.requestRender();
      return;
    }

    if (event.type === "message_update") {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        const block = this.#messages.find((item) => item.id === this.#currentAssistantBlockId);
        if (block) {
          block.text = `${block.text ?? ""}${delta.text}`;
          block.lines = [block.text];
        }
      }
      this.#host.requestRender();
      return;
    }

    if (event.type === "message_end") {
      const block = this.#messages.find((item) => item.id === this.#currentAssistantBlockId);
      if (block) {
        block.live = false;
        block.title = event.message.role === "assistant" ? "MingXu" : event.message.role;
        block.text = event.message.content ?? block.text;
        block.lines = block.text ? wrapText(block.text, 120) : block.lines;
      }
      this.#host.requestRender();
      return;
    }

    if (event.type === "tool_execution_start") {
      const block: ConversationBlock = {
        id: event.toolCall.id,
        kind: "tool",
        title: `tool ${event.toolCall.name} (running)`,
        lines: [formatToolInput(event.toolCall.input)],
      };
      this.#currentToolBlocks.set(event.toolCall.id, block);
      this.#messages.push(block);
      this.#host.requestRender();
      return;
    }

    if (event.type === "tool_execution_update") {
      const block = this.#currentToolBlocks.get(event.toolCall.id);
      if (block) {
        block.lines.push(formatToolInput(event.partialResult));
      }
      this.#host.requestRender();
      return;
    }

    if (event.type === "tool_execution_end") {
      const block = this.#currentToolBlocks.get(event.toolCall.id);
      if (block) {
        block.title = `tool ${event.toolCall.name} (${event.result.isError ? "error" : "done"})`;
        block.lines.push(formatToolInput(event.result.output));
      }
      this.#currentToolBlocks.delete(event.toolCall.id);
      this.#host.requestRender();
      return;
    }

    if (event.type === "turn_end") {
      this.#running = false;
      this.#host.requestRender();
      return;
    }

    if (event.type === "agent_end") {
      this.#running = false;
      this.#host.requestRender();
      return;
    }

    if (event.type === "error") {
      this.#running = false;
      this.#messages.push({
        id: `error-${Date.now()}`,
        kind: "error",
        title: "agent error",
        lines: [event.error],
      });
      this.#host.requestRender();
    }
  }

  #handleKeypress(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void {
    if (this.#approval) {
      this.#handleApprovalInput(input);
      return;
    }

    if (this.#activePanel?.kind === "select") {
      this.#handleSelectPanelInput(input, this.#activePanel);
      return;
    }

    if (this.#activePanel?.kind === "text") {
      if (input.name === "escape" || input.name === "return" || input.name === "enter" || (input.ctrl && input.name === "c")) {
        this.#activePanel = undefined;
        this.#host.requestRender();
      }
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
      this.#host.requestRender();
    }
  }

  #handleSelectPanelInput(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }, panel: SelectPanel): void {
    if (input.name === "up") {
      panel.selectedIndex = (panel.selectedIndex - 1 + panel.items.length) % panel.items.length;
      this.#host.requestRender();
      return;
    }
    if (input.name === "down") {
      panel.selectedIndex = (panel.selectedIndex + 1) % panel.items.length;
      this.#host.requestRender();
      return;
    }
    if (input.name === "escape" || (input.ctrl && input.name === "c")) {
      this.#activePanel = undefined;
      this.#host.requestRender();
      return;
    }
    if (input.name === "enter" || input.name === "return") {
      const item = panel.items[panel.selectedIndex] ?? panel.items[0];
      if (item) {
        void panel.onChoose(item);
      }
      return;
    }
    if (input.sequence === "1" && panel.items.length > 0) {
      panel.selectedIndex = 0;
      this.#host.requestRender();
      return;
    }
    if (input.sequence === "2" && panel.items.length > 1) {
      panel.selectedIndex = 1;
      this.#host.requestRender();
      return;
    }
    if (input.sequence === "3" && panel.items.length > 2) {
      panel.selectedIndex = 2;
      this.#host.requestRender();
    }
  }

  async #handleCommand(command: string): Promise<void> {
    const normalized = command.trim().replace(/^\/+/u, "");
    if (!normalized) {
      return;
    }
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
        this.#messages.length = 0;
        this.#host.requestRender();
        return;
      case "compact":
        this.#messages.push({
          id: `status-${Date.now()}`,
          kind: "status",
          title: "compact",
          lines: ["Conversation compaction is managed by the runtime."],
        });
        this.#host.requestRender();
        return;
      case "steer":
        if (!args) {
          this.#messages.push({
            id: `status-${Date.now()}`,
            kind: "status",
            title: "steer",
            lines: ["Usage: /steer [text]"],
          });
        } else {
          this.#currentSession.steer(args);
          this.#messages.push({
            id: `status-${Date.now()}`,
            kind: "status",
            title: "steer",
            lines: ["Queued steering instruction for the next model turn."],
          });
        }
        this.#host.requestRender();
        return;
      case "exit":
      case "quit":
        this.exit();
        return;
      default:
        this.#messages.push({
          id: `error-${Date.now()}`,
          kind: "error",
          title: "unknown command",
        lines: [`/${name}`],
      });
      this.#host.requestRender();
    }
  }

  async #switchSession(request: CliSessionRequest): Promise<void> {
    if (this.#running) {
      this.#messages.push({
        id: `error-${Date.now()}`,
        kind: "error",
        title: "busy",
        lines: ["Wait for the current run to finish before switching session or model."],
      });
      this.#host.requestRender();
      return;
    }

    this.#currentSession = this.#runtime.createSession({
      ...(request.modelKey !== undefined ? { modelKey: request.modelKey } : {}),
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      ...(request.preset !== undefined ? { preset: request.preset } : {}),
      interactive: true,
      approvalHandler: (prompt) => this.openApproval(prompt),
    });
    this.#currentModelKey = request.modelKey ?? this.#currentModelKey;
    this.#currentSessionId = request.sessionId ?? this.#currentSessionId;
    this.#messages.push({
      id: `status-${Date.now()}`,
      kind: "status",
      title: "session switched",
      lines: [
        `model: ${this.#currentModelKey ?? "default"}`,
        `session: ${this.#currentSessionId ?? "new"}`,
      ],
    });
    this.#bindSession(this.#currentSession);
    await this.#refreshSnapshot();
    this.#host.requestRender();
  }

  #enqueuePrompt(prompt: string): void {
    if (!prompt.trim()) return;
    if (this.#running) {
      this.#currentSession.followUp(prompt.trim());
      this.#messages.push({
        id: `queued-${Date.now()}`,
        kind: "status",
        title: "queued follow-up",
        lines: [prompt.trim()],
      });
      this.#host.requestRender();
      return;
    }
    void this.runPrompt(prompt.trim()).catch(() => undefined);
  }

  #pushStatus(message: string): void {
    this.#lastStatus = message;
    this.#host.requestRender();
  }

  #shutdown(): void {
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
    this.#messages.push({
      id: `user-${Date.now()}`,
      kind: "user",
      title: "you",
      lines: wrapText(text, 120),
    });
  }

  #renderConversation(width: number): string[] {
    const lines: string[] = [];
    const blocks = this.#messages;
    if (blocks.length === 0) {
      lines.push("No messages yet. Type a prompt or /help.");
      return lines;
    }

    for (const block of blocks.slice(-12)) {
      lines.push(`[${block.kind}] ${block.title}`);
      const bodyLines = block.text !== undefined && block.kind === "assistant"
        ? wrapText(block.text, Math.max(20, width - 4))
        : block.lines;
      for (const line of bodyLines) {
        const wrapped = wrapText(line, Math.max(20, width - 4));
        for (const entry of wrapped) {
          lines.push(`  ${truncateToWidth(entry, Math.max(20, width - 2))}`);
        }
      }
      if (block.live) {
        lines.push("  ...");
      }
      lines.push("");
    }

    return lines.slice(0, Math.max(1, this.#terminal.size.rows - 8));
  }

  #renderPanel(width: number): string[] {
    if (this.#approval) {
      return this.#renderApprovalPanel(width);
    }
    const panel = this.#activePanel;
    if (!panel) {
      return [];
    }
    if (panel.kind === "text") {
      return new Box(new StaticLines(panel.lines), panel.title).render(width);
    }
    const selected = panel.items[panel.selectedIndex] ?? panel.items[0];
    const listLines = [
      ...(panel.note ? wrapText(panel.note, Math.max(20, width - 4)) : []),
      ...new SelectList(panel.items.map((item) => ({
        id: item.id,
        label: item.label,
        ...(item.detailLines[0] !== undefined ? { description: item.detailLines[0] } : {}),
      })), panel.title).render(width),
      "",
      ...(selected ? selected.detailLines.flatMap((line) => wrapText(line, Math.max(20, width - 4))) : ["No item selected."]),
    ];
    return new Box(new StaticLines(listLines), panel.title).render(width);
  }

  #renderApprovalPanel(width: number): string[] {
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
      `reason: ${prompt.reason}`,
      `policy: ${prompt.policyEffect}`,
      `principal: ${prompt.principalId}`,
      `action: ${prompt.actionKind}`,
      `resource: ${prompt.resourceScope}`,
      `input: ${formatToolInput(prompt.input)}`,
      "",
      ...new SelectList(items, "approval choices").render(width),
      "",
      ...(selected ? selected.detailLines.flatMap((line) => wrapText(line, Math.max(20, width - 4))) : []),
      "Use Up/Down or 1/2/3, then Enter. Esc denies.",
    ];
    return new Box(new StaticLines(lines), "approval").render(width);
  }
}

class CliTuiScreen implements Component {
  readonly #app: CliTuiApp;

  constructor(app: CliTuiApp) {
    this.#app = app;
  }

  handleInput(input: KeyInput): void {
    this.#app.handleInput(input);
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.#app.render(width);
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
