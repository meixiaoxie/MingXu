import type { SessionEntry } from "../session/session-entry.js";
import type { AgentMessage } from "../core/types.js";
import type { AgentContext } from "../core/context.js";

/**
 * 从 session entries 构建 AgentContext。
 * 找到最后一个 compact boundary 之后的所有 entries 来还原消息。
 * compact boundary 之前的消息已经被压缩成摘要了。
 */
export function buildContextFromEntries(
  entries: SessionEntry[],
  systemPrompt?: string,
): AgentContext {
  // 找最后一个 compact boundary
  let startIndex = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compact_boundary") {
      startIndex = i + 1;
      break;
    }
  }

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

/**
 * 从 session entries 里提取消息列表（不含 summary/boundary 等元数据）。
 */
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
