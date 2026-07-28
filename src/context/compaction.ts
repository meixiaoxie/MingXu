import type { AgentMessage } from "../core/types.js";
import {
  estimateContextTokens,
  estimateMessageTokens,
} from "./token-estimator.js";
import type { SummaryGenerator } from "./summary-generator.js";
import { defaultSummaryGenerator } from "./summary-generator.js";
import { createRuntimeId } from "../core/runtime-id.js";

/**
 * CompactionSettings：上下文压缩的配置。
 */
export interface CompactionSettings {
  enabled: boolean;
  maxContextTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: false,
  maxContextTokens: 200_000,
  reserveTokens: 16_000,
  keepRecentTokens: 20_000,
};

export interface CompactionResult {
  messages: AgentMessage[];
  didCompact: boolean;
  archivedIds: string[];
  summaryMessageId?: string;
}

/**
 * 判断是否需要压缩。
 * 规则：当前 token 使用量 >= maxContextTokens - reserveTokens
 * 即"已经用了最大上下文减去留给输出的空间"，再不停就要溢出了。
 */
export function shouldCompact(
  messages: AgentMessage[],
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;

  const { total } = estimateContextTokens(messages);
  return total >= settings.maxContextTokens - settings.reserveTokens;
}

/**
 * 找安全切分点，把消息分成"要归档的"和"要保留的"两部分。
 *
 * 从后往前累积 token，当累积的 token 接近 keepRecentTokens 时停止。
 * 重要：不会在工具调用链条中间切开——如果最后一条是 toolResult，
 * 会把对应的 assistant + toolCalls 也保留下来，确保模型看到完整的工具调用对。
 */
export function findCutPoint(
  messages: AgentMessage[],
  settings: CompactionSettings,
): { archived: AgentMessage[]; retained: AgentMessage[] } {
  let retainedTokens = 0;
  const retained: AgentMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    const tokens = estimateMessageTokens(msg);

    if (
      retainedTokens + tokens > settings.keepRecentTokens &&
      retained.length > 0
    ) {
      // 如果当前是 toolResult，需要把对应的 assistant 也保留
      // 不然模型会看到孤立的 toolResult 而没有对应的工具调用请求
      if (msg.role === "toolResult") {
        retained.unshift(msg);
        retainedTokens += tokens;
        continue;
      }
      break;
    }

    retained.unshift(msg);
    retainedTokens += tokens;
  }

  return {
    archived: messages.slice(0, messages.length - retained.length),
    retained,
  };
}

/**
 * 执行完整压缩流程：
 * 1. 判断是否需要压缩
 * 2. 找切分点
 * 3. 生成摘要
 * 4. 组装 compressed messages = summary + compact_boundary + retained_tail
 */
export async function compactMessages(
  messages: AgentMessage[],
  settings: CompactionSettings,
  generateSummary: SummaryGenerator = defaultSummaryGenerator,
): Promise<CompactionResult> {
  if (!shouldCompact(messages, settings)) {
    return { messages, didCompact: false, archivedIds: [] };
  }

  const { archived, retained } = findCutPoint(messages, settings);
  if (archived.length === 0) {
    return { messages, didCompact: false, archivedIds: [] };
  }

  const summary = await generateSummary(archived);
  const summaryId = createRuntimeId("summary");

  // 摘要消息：用 summary 角色标记
  const summaryMessage: AgentMessage = {
    id: summaryId,
    role: "summary",
    content: summary,
    createdAt: new Date().toISOString(),
    range: {
      fromId: archived[0]!.id,
      toId: archived[archived.length - 1]!.id,
    },
  };

  // compact boundary 标记：记录归档了哪些消息
  const compactBoundary: AgentMessage = {
    id: createRuntimeId("compact-boundary"),
    role: "system",
    content: `Compaction boundary: messages before ${archived[archived.length - 1]!.id} have been summarized`,
    createdAt: new Date().toISOString(),
    visibleToModel: false,
    metadata: {
      kind: "compact_boundary",
      summaryMessageId: summaryId,
      archivedCount: archived.length,
    },
  };

  return {
    messages: [summaryMessage, compactBoundary, ...retained],
    didCompact: true,
    archivedIds: archived.map((m) => m.id),
    summaryMessageId: summaryId,
  };
}
