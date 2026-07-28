import type { AgentMessage } from "../core/types.js";
import type { ModelUsage } from "../models/model-protocol.js";

/** 默认最大上下文 token 数（200k 是大多数现代模型的上下文窗口） */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
/** 预留给模型输出的 token，这部分空间不能给历史消息用 */
export const DEFAULT_RESERVE_TOKENS = 16_000;
/** 压缩后保留的最近消息 token 数——始终保留最近对话尾巴 */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/**
 * 粗估消息的 token 数。
 * 简单策略：字符数除以 4。中文每个字大约占 1-2 个 token，
 * 英文大约 4 个字符 = 1 个 token，折中使用 4 作为粗略估算。
 * 实际上后续会优先用 API response 里的 usage 精确值覆盖。
 */
export function estimateMessageTokens(message: AgentMessage): number {
  return Math.ceil(message.content.length / 4);
}

/** 批量估算消息列表的 token 数 */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

/**
 * 从消息列表中提取最近一次 API 返回的精确 token 统计。
 * 从后往前找，优先用最后一个 assistant 消息的 usage 值。
 */
export function getLastUsage(
  messages: AgentMessage[],
): ModelUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && msg.usage?.totalTokens) {
      return msg.usage;
    }
  }
  return undefined;
}

/**
 * 估算当前上下文的 token 使用量。
 * 优先用最近 assistant 消息的 usage（来自 API 返回的精确值）。
 * 如果没有 usage 数据，就用字符数除以 4 粗略估算。
 */
export function estimateContextTokens(messages: AgentMessage[]): {
  total: number;
  fromUsage: boolean;
} {
  const usage = getLastUsage(messages);
  if (usage?.totalTokens !== undefined && usage.totalTokens > 0) {
    return { total: usage.totalTokens, fromUsage: true };
  }
  return { total: estimateMessagesTokens(messages), fromUsage: false };
}
