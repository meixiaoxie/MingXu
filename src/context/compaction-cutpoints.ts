import type { AgentMessage } from "../core/types.js";
import type { CompactionSettings } from "./compaction.js";
import { estimateMessageTokens } from "./token-estimator.js";

export interface CompactionCutPoint {
  archived: AgentMessage[];
  retained: AgentMessage[];
}

/**
 * 从后往前找一个安全的压缩切点。
 * 切点之后的消息会保留为当前模型的尾巴，切点之前的消息会归档成摘要。
 */
export function findCompactionCutPoint(
  messages: AgentMessage[],
  settings: CompactionSettings,
): CompactionCutPoint {
  let retainedTokens = 0;
  const retained: AgentMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    const tokens = estimateMessageTokens(message);

    if (retainedTokens + tokens > settings.keepRecentTokens && retained.length > 0) {
      if (message.role === "toolResult") {
        retained.unshift(message);
        retainedTokens += tokens;
        continue;
      }
      break;
    }

    retained.unshift(message);
    retainedTokens += tokens;
  }

  return {
    archived: messages.slice(0, messages.length - retained.length),
    retained,
  };
}

/**
 * 分支摘要记录：在 JSONL 里标出某条消息开始进入新分支。
 */
export function createBranchPointEntry(args: {
  id: string;
  sessionId: string;
  createdAt: string;
  branchName: string;
  parentBranchId?: string;
  parentId?: string;
}) {
  return {
    id: args.id,
    type: "branch_point" as const,
    sessionId: args.sessionId,
    createdAt: args.createdAt,
    ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
    branchName: args.branchName,
    ...(args.parentBranchId !== undefined ? { parentBranchId: args.parentBranchId } : {}),
  };
}
