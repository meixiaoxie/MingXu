import type { SessionEntry } from "../session/session-entry.js";
import type { AgentMessage } from "../core/messages.js";
import type { AgentContext } from "../core/context.js";

function getLatestCutIndex(entries: SessionEntry[]): number {
  let startIndex = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]!.type === "compact_boundary" || entries[i]!.type === "branch_point") {
      startIndex = i + 1;
      break;
    }
  }
  return startIndex;
}

export function buildContextFromEntries(
  entries: SessionEntry[],
  systemPrompt?: string,
): AgentContext {
  const startIndex = getLatestCutIndex(entries);

  const messages: AgentMessage[] = [];

  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i]!;

    if (entry.type === "message") {
      messages.push(entry.message);
    } else if (entry.type === "summary") {
      messages.push({
        id: entry.id,
        role: "summary",
        content: entry.summary,
        createdAt: entry.createdAt,
        range: entry.range,
      });
    }
  }

  const result: AgentContext = {
    messages,
    tools: [],
  };
  if (systemPrompt !== undefined) {
    result.systemPrompt = systemPrompt;
  }
  return result;
}

export function entriesToMessages(entries: SessionEntry[]): AgentMessage[] {
  return entries.flatMap((entry) => {
    if (entry.type === "message") return [entry.message];
    if (entry.type === "summary") {
      return [
        {
          id: entry.id,
          role: "summary" as const,
          content: entry.summary,
          createdAt: entry.createdAt,
          range: entry.range,
        },
      ];
    }
    return [];
  });
}
