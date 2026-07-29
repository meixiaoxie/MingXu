/**
 * MemoryScope：记忆的作用范围。
 *
 * 类比：就像不同层级的配置文件夹——
 * - user：用户全局配置（~/.claude/memory/），对所有项目生效
 * - project：当前项目配置（项目根目录 MINGXU.md），只对这个项目生效
 * - local：本地工作目录配置
 * - session：当前会话配置（通常是临时的，关掉就没了）
 */
export type MemoryScope = "user" | "project" | "local" | "session";

/**
 * MemoryEntry：一条记忆记录。
 *
 * 每一条记忆都有 scope（存在哪层）、key（叫什么名字）、content（内容是什么）。
 */
export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  key: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * MemoryQuery：查询记忆的筛选条件。
 *
 * 可以按 scope 过滤（只看项目级记忆）、按 key 精确查找（找特定的文件）、
 * 或按关键词搜索（query 字段）。
 */
export interface MemoryQuery {
  scope?: MemoryScope;
  key?: string;
  /** 搜索关键词——会在 key 和 content 中模糊匹配 */
  query?: string;
}
