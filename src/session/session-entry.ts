import type { AgentMessage } from "../core/messages.js";

export type SessionEntryType =
  | "message"
  | "summary"
  | "compact_boundary"
  | "metadata"
  | "branch_point";

export interface SessionEntryBase {
  id: string;
  type: SessionEntryType;
  sessionId: string;
  createdAt: string;
  parentId?: string;
}

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
