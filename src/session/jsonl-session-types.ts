import type { SessionEntry } from "../session/session-entry.js";

/**
 * JsonlSessionStore：追加式 JSONL 会话存储接口。
 *
 * 和旧版 SessionStore（src/session/session-store.ts）职责不同：
 * - 旧版：面向"文档级"会话管理（创建、保存、归档）
 * - 新版：面向"条目级"会话记录（逐行追加、树形结构、分支追溯）
 *
 * 两者可以共存——旧版 session 继续用，新版 JSONL 作为附加的持久化层。
 */
export interface JsonlSessionStore {
  /** 追加一条记录 */
  append(entry: SessionEntry): Promise<void>;
  /** 加载某个会话的所有记录 */
  load(sessionId: string): Promise<SessionEntry[]>;
  /** 获取某个 entry 的祖先链（从根到该 entry） */
  getAncestorChain(entryId: string): Promise<SessionEntry[]>;
  /** 获取某个 entry 的所有直接子节点 */
  getChildren(parentId: string): Promise<SessionEntry[]>;
  /** 获取会话的所有叶子节点 */
  getLeaves(sessionId: string): Promise<SessionEntry[]>;
  /** 获取最新叶子 */
  getLatestLeaf(sessionId: string): Promise<SessionEntry | undefined>;
  /** 清空会话 */
  clear(sessionId: string): Promise<void>;
}
