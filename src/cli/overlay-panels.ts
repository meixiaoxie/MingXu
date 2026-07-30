import type { ComponentAction, KeyInput, OverlayFrame } from "@mingxu/tui";
import { Box, SelectList, Text, truncateToWidth, visibleWidth, wrapText } from "@mingxu/tui";
import { sanitizeTerminalText } from "@mingxu/tui";
import type { ApprovalPrompt, ApprovalResponse } from "../approval/types.js";

export interface OverlayActions {
  readonly close: () => void;
  readonly requestRender: () => void;
  readonly pushOverlay: (overlay: OverlayFrame) => void;
}

export interface OverlayTextSpec {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly lines: readonly string[];
  readonly actions: OverlayActions;
}

export interface OverlaySelectItem<T> {
  readonly id: string;
  readonly label: string;
  readonly detailLines: readonly string[];
  readonly value: T;
}

export interface OverlaySelectSpec<T> {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly items: readonly OverlaySelectItem<T>[];
  readonly actions: OverlayActions;
  readonly note?: string;
  readonly filterable?: boolean;
  readonly onChoose: (item: OverlaySelectItem<T>, actions: OverlayActions) => Promise<boolean | void> | boolean | void;
}

export function createTextOverlay(spec: OverlayTextSpec): OverlayFrame {
  const state = {
    scroll: 0,
  };
  return {
    id: spec.id,
    priority: spec.priority,
    render(width: number, height?: number): string[] {
      const innerWidth = Math.max(20, width - 4);
      const availableHeight = Math.max(4, (height ?? 12) - 4);
      const bodyLines = spec.lines.flatMap((line) => wrapText(sanitizeTerminalText(line), innerWidth));
      const maxScroll = Math.max(0, bodyLines.length - availableHeight);
      state.scroll = Math.max(0, Math.min(state.scroll, maxScroll));
      const visible = bodyLines.slice(state.scroll, state.scroll + availableHeight);
      const footer = maxScroll > 0
        ? `Scroll ${state.scroll + 1}-${Math.min(bodyLines.length, state.scroll + availableHeight)} of ${bodyLines.length}`
        : "Esc closes";
      const content = [
        `title: ${spec.title}`,
        "",
        ...visible,
        "",
        footer,
      ];
      return new Box(new Text({ text: content.join("\n") }), spec.title).render(width);
    },
    handleInput(input: KeyInput): ComponentAction | void {
      if (input.name === "escape" || (input.ctrl && input.name === "c")) {
        spec.actions.close();
        return { type: "cancel" };
      }
      if (input.name === "up") {
        state.scroll = Math.max(0, state.scroll - 1);
        spec.actions.requestRender();
        return { type: "none" };
      }
      if (input.name === "down") {
        state.scroll += 1;
        spec.actions.requestRender();
        return { type: "none" };
      }
      if (input.name === "pageup") {
        state.scroll = Math.max(0, state.scroll - 5);
        spec.actions.requestRender();
        return { type: "none" };
      }
      if (input.name === "pagedown") {
        state.scroll += 5;
        spec.actions.requestRender();
        return { type: "none" };
      }
      if (input.name === "home") {
        state.scroll = 0;
        spec.actions.requestRender();
        return { type: "none" };
      }
      if (input.name === "end") {
        state.scroll = Number.MAX_SAFE_INTEGER;
        spec.actions.requestRender();
        return { type: "none" };
      }
      return { type: "none" };
    },
    invalidate(): void {},
  };
}

export function createSelectOverlay<T>(spec: OverlaySelectSpec<T>): OverlayFrame {
  const state = {
    filter: "",
    selectedIndex: 0,
  };

  const visibleItems = (): readonly OverlaySelectItem<T>[] => {
    const filter = state.filter.trim().toLowerCase();
    if (!filter) {
      return spec.items;
    }
    return spec.items.filter((item) => {
      const haystack = `${item.label}\n${item.detailLines.join("\n")}`.toLowerCase();
      return haystack.includes(filter);
    });
  };

  const syncSelection = (): readonly OverlaySelectItem<T>[] => {
    const items = visibleItems();
    if (items.length === 0) {
      state.selectedIndex = 0;
      return items;
    }
    state.selectedIndex = Math.max(0, Math.min(state.selectedIndex, items.length - 1));
    return items;
  };

  const renderBody = (width: number, height: number): string[] => {
    const items = syncSelection();
    const bodyWidth = Math.max(20, width - 6);
    const listWidth = Math.max(20, width - 8);
    const list = new SelectList(items.map((item) => ({
      id: item.id,
      label: item.label,
      ...(item.detailLines[0] !== undefined ? { description: item.detailLines[0] } : {}),
    })), spec.title);
    for (let index = 0; index < state.selectedIndex; index += 1) {
      list.move(1);
    }
    const filterLine = `filter: ${state.filter || "(none)"} | ${items.length}/${spec.items.length}`;
    const noteLines = spec.note ? wrapText(spec.note, bodyWidth) : [];
    const selected = items[state.selectedIndex];
    const detailLines = selected ? selected.detailLines.flatMap((line) => wrapText(line, bodyWidth)) : ["No item selected."];
    const listLines = list.render(listWidth);
    const content = [
      filterLine,
      "",
      ...noteLines,
      ...(noteLines.length > 0 ? [""] : []),
      ...listLines,
      "",
      ...detailLines,
      "",
      "Type to filter, Enter selects, Esc closes.",
    ];
    const visible = content.slice(0, Math.max(4, height - 2));
    return new Box(new Text({ text: visible.join("\n") }), spec.title).render(width);
  };

  return {
    id: spec.id,
    priority: spec.priority,
    render(width: number, height?: number): string[] {
      const panelHeight = Math.max(8, height ?? 14);
      return renderBody(width, panelHeight);
    },
    handleInput(input: KeyInput): ComponentAction | void {
      if (input.name === "escape" || (input.ctrl && input.name === "c")) {
        spec.actions.close();
        return { type: "cancel" };
      }
      if (input.name === "up") {
        state.selectedIndex = Math.max(0, state.selectedIndex - 1);
        spec.actions.requestRender();
        return { type: "none" };
      }
      if (input.name === "down") {
        state.selectedIndex += 1;
        spec.actions.requestRender();
        return { type: "none" };
      }
      if (input.name === "pageup") {
        state.selectedIndex = Math.max(0, state.selectedIndex - 5);
        spec.actions.requestRender();
        return { type: "none" };
      }
      if (input.name === "pagedown") {
        state.selectedIndex += 5;
        spec.actions.requestRender();
        return { type: "none" };
      }
      if (input.name === "backspace") {
        state.filter = state.filter.slice(0, -1);
        state.selectedIndex = 0;
        spec.actions.requestRender();
        return { type: "none" };
      }
      if (input.name === "enter" || input.name === "return") {
        const items = syncSelection();
        const item = items[state.selectedIndex] ?? items[0];
        if (!item) {
          return { type: "none" };
        }
        const result = spec.onChoose(item, spec.actions);
        if (typeof result === "boolean" && result === false) {
          return { type: "none" };
        }
        void Promise.resolve(result).then((keepOpen) => {
          if (keepOpen === false) {
            return;
          }
          spec.actions.close();
        });
        if (!(result instanceof Promise)) {
          spec.actions.close();
        }
        return { type: "submit", value: item.id };
      }
      if (input.sequence === "1" || input.sequence === "2" || input.sequence === "3" || input.sequence === "4" || input.sequence === "5" || input.sequence === "6" || input.sequence === "7" || input.sequence === "8" || input.sequence === "9") {
        const index = Number.parseInt(input.sequence, 10) - 1;
        const items = syncSelection();
        if (index >= 0 && index < items.length) {
          state.selectedIndex = index;
          spec.actions.requestRender();
        }
        return { type: "none" };
      }
      if (input.sequence && !input.ctrl && !input.meta && input.sequence.length === 1) {
        state.filter += input.sequence;
        state.selectedIndex = 0;
        spec.actions.requestRender();
        return { type: "none" };
      }
      return { type: "none" };
    },
    invalidate(): void {},
  };
}

export function createApprovalOverlay(spec: {
  readonly id: string;
  readonly priority: number;
  readonly prompt: ApprovalPrompt;
  readonly actions: OverlayActions;
  readonly resolve: (response: ApprovalResponse | undefined) => void;
}): OverlayFrame {
  const items: readonly OverlaySelectItem<ApprovalResponse>[] = [
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
  return createSelectOverlay<ApprovalResponse>({
    id: spec.id,
    title: "approval",
    priority: spec.priority,
    items,
    actions: spec.actions,
    note: [
      `tool: ${spec.prompt.toolName}`,
      `principal: ${spec.prompt.principalId}`,
      `policy: ${spec.prompt.policyEffect}`,
      `risk: ${spec.prompt.risk ?? "n/a"}`,
      `resource: ${spec.prompt.normalizedResource ?? spec.prompt.resourceScope}`,
      `action: ${spec.prompt.actionKind}`,
      `source: ${spec.prompt.source ?? "local"}`,
      `reason: ${spec.prompt.reason}`,
      `input: ${summarizeInput(spec.prompt.input)}`,
      ...(spec.prompt.policyObligations && spec.prompt.policyObligations.length > 0
        ? [`policy obligations: ${spec.prompt.policyObligations.length}`]
        : []),
      ...(spec.prompt.policyDetails && spec.prompt.policyDetails.length > 0
        ? [`policy details: ${spec.prompt.policyDetails.join(" | ")}`]
        : []),
    ].join("\n"),
    onChoose: (item) => {
      spec.resolve(item.value);
      return true;
    },
  });
}

export function createErrorOverlay(spec: {
  readonly id: string;
  readonly priority: number;
  readonly title: string;
  readonly lines: readonly string[];
  readonly actions: OverlayActions;
}): OverlayFrame {
  return createTextOverlay({
    id: spec.id,
    title: spec.title,
    priority: spec.priority,
    lines: spec.lines,
    actions: spec.actions,
  });
}

function summarizeInput(value: unknown): string {
  if (typeof value === "string") {
    return sanitizeTerminalText(value);
  }
  try {
    return truncateToWidth(JSON.stringify(value), 120);
  } catch {
    return visibleWidth(String(value)) > 120 ? truncateToWidth(String(value), 120) : String(value);
  }
}
