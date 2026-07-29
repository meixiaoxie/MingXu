import type { SessionEntry } from "./session-entry.js";

export interface JsonlSessionStore {
  append(entry: SessionEntry): Promise<void>;
  load(sessionId: string): Promise<SessionEntry[]>;
  getAncestorChain(entryId: string): Promise<SessionEntry[]>;
  getChildren(parentId: string): Promise<SessionEntry[]>;
  getLeaves(sessionId: string): Promise<SessionEntry[]>;
  getLatestLeaf(sessionId: string): Promise<SessionEntry | undefined>;
  clear(sessionId: string): Promise<void>;
}
