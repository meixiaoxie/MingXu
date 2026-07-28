import type { MemoryEntry, MemoryQuery, MemoryScope } from "./memory-scope.js";

/**
 * 记忆管理器接口。
 *
 * 不同 scope 的记忆来源：
 * - user: 用户级记忆（~/.claude/memory/）
 * - project: 项目级记忆（CLAUDE.md 等）
 * - local: 本地工作目录记忆
 * - session: 当前会话记忆
 */
export interface MemoryManager {
  query(query: MemoryQuery): Promise<MemoryEntry[]>;
  save(
    entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">,
  ): Promise<MemoryEntry>;
  delete(id: string): Promise<boolean>;
  listScopes(): MemoryScope[];
}
