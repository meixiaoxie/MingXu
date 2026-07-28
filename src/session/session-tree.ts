import type { SessionEntry } from "./session-entry.js";

/**
 * Session 树结构，用于从扁平 JSONL entries 构建会话树的展示。
 */
export interface SessionNode {
  entry: SessionEntry;
  children: SessionNode[];
  depth: number;
}

export interface SessionTree {
  root: SessionNode;
  leaves: SessionNode[];
  /** 所有节点按创建时间排序 */
  flatList: SessionEntry[];
}

/**
 * 从 entries 构建 session 树。
 *
 * 三遍扫描：
 * 1. 创建所有节点
 * 2. 建立父子关系
 * 3. 计算深度并找出叶子
 */
export function buildSessionTree(entries: SessionEntry[]): SessionTree {
  if (entries.length === 0) {
    const rootEntry: SessionEntry = {
      id: "root",
      type: "metadata",
      sessionId: "",
      createdAt: new Date().toISOString(),
      key: "empty",
      value: null,
    };
    return {
      root: { entry: rootEntry, children: [], depth: 0 },
      leaves: [],
      flatList: [],
    };
  }

  const byId = new Map<string, SessionNode>();
  const roots: SessionNode[] = [];

  // 第一遍：创建所有节点
  for (const entry of entries) {
    byId.set(entry.id, { entry, children: [], depth: 0 });
  }

  // 第二遍：建立父子关系
  for (const entry of entries) {
    const node = byId.get(entry.id)!;
    if (entry.parentId && byId.has(entry.parentId)) {
      byId.get(entry.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // 第三遍：计算深度
  for (const root of roots) {
    setDepth(root, 0);
  }

  // 找叶子
  const leaves: SessionNode[] = [];
  for (const root of roots) {
    collectLeaves(root, leaves);
  }

  const root = roots[0] ?? {
    entry: entries[0]!,
    children: [],
    depth: 0,
  };

  return { root, leaves, flatList: entries };
}

function setDepth(node: SessionNode, depth: number): void {
  node.depth = depth;
  for (const child of node.children) {
    setDepth(child, depth + 1);
  }
}

function collectLeaves(node: SessionNode, leaves: SessionNode[]): void {
  if (node.children.length === 0) {
    leaves.push(node);
  } else {
    for (const child of node.children) {
      collectLeaves(child, leaves);
    }
  }
}

/**
 * 从叶子节点回溯到根，收集所有 entry 的消息。
 */
export function collectMessagesFromLeaf(
  leaf: SessionEntry,
  allEntries: SessionEntry[],
): SessionEntry[] {
  const byId = new Map(allEntries.map((e) => [e.id, e]));
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;

  while (current) {
    chain.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return chain;
}
