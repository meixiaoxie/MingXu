import type { SessionEntry } from "./session-entry.js";

export interface SessionNode {
  entry: SessionEntry;
  children: SessionNode[];
}

export interface SessionTree {
  root: SessionNode;
  flatList: SessionEntry[];
}

export function buildSessionTree(entries: SessionEntry[]): SessionTree {
  const rootEntry: SessionEntry = {
    id: "root",
    type: "metadata",
    sessionId: entries[0]?.sessionId ?? "session",
    createdAt: entries[0]?.createdAt ?? new Date().toISOString(),
    key: "root",
    value: null,
  };

  return {
    root: {
      entry: rootEntry,
      children: entries.map((entry) => ({ entry, children: [] })),
    },
    flatList: [...entries],
  };
}

export function collectMessagesFromLeaf(leaf: SessionEntry, allEntries: SessionEntry[]): SessionEntry[] {
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;

  while (current) {
    chain.unshift(current);
    current = current.parentId ? allEntries.find((entry) => entry.id === current?.parentId) : undefined;
  }

  return chain;
}
