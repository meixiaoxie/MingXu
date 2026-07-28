import type { AgentMessage } from "../core/types.js";

/**
 * SessionEntry 的类型标签。
 * 用标签区分不同类型的记录，这样 JSONL 文件可以混合存放各种记录。
 */
export type SessionEntryType =
  | "message"
  | "summary"
  | "compact_boundary"
  | "metadata"
  | "branch_point";

/** 所有 session entry 的公共字段 */
export interface SessionEntryBase {
  id: string;
  type: SessionEntryType;
  sessionId: string;
  createdAt: string;
  /** 父 entry 的 ID，用于构建 session 树。没有 parentId = 根节点 */
  parentId?: string;
}

/**
 * SessionEntry：JSONL session 文件中的一条记录。
 *
 * JSONL session 和传统 JSON session 的区别：
 * - JSONL 是"追加写入"（append-only），每行一条记录，即使程序崩溃也不会丢已写数据
 * - JSON 是"整体覆盖"（write-all），每次写都要序列化整个文件，大 session 很慢且不安全
 */
export type SessionEntry =
  | (SessionEntryBase & { type: "message"; message: AgentMessage })
  | (SessionEntryBase & {
      type: "summary";
      summary: string;
      range: { fromId: string; toId: string };
    })
  | (SessionEntryBase & {
      type: "compact_boundary";
      beforeMessageId: string;
      summaryMessageId: string;
    })
  | (SessionEntryBase & {
      type: "metadata";
      key: string;
      value: unknown;
    })
  | (SessionEntryBase & {
      type: "branch_point";
      branchName: string;
      parentBranchId?: string;
    });
