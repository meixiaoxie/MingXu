import { readFile, mkdir, readdir, writeFile, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { createRuntimeId } from "../core/runtime-id.js";
import type { MemoryEntry, MemoryQuery, MemoryScope } from "./memory-scope.js";
import type { MemoryManager } from "./memory-manager.js";

const PROJECT_INSTRUCTION_FILES = new Set(["MINGXU.md", "CLAUDE.md", "AGENTS.md"]);

/**
 * 基于文件的记忆存储。
 *
 * 每个 scope 对应一个目录，目录下的 .md 文件就是一条记忆。
 * 文件名 = key，文件内容 = 记忆内容。
 * 项目说明文件（MINGXU.md / CLAUDE.md / AGENTS.md）不当作记忆读取。
 */
export class FileMemoryStore implements MemoryManager {
  readonly #basePaths = new Map<MemoryScope, string>();

  constructor(basePaths: Partial<Record<MemoryScope, string>> = {}) {
    for (const [scope, path] of Object.entries(basePaths)) {
      if (path) this.#basePaths.set(scope as MemoryScope, path);
    }
  }

  addScope(scope: MemoryScope, path: string): void {
    this.#basePaths.set(scope, path);
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];
    const scopes = query.scope
      ? [query.scope]
      : [...this.#basePaths.keys()];

    for (const scope of scopes) {
      const dirPath = this.#basePaths.get(scope);
      if (!dirPath) continue;

      try {
        const entries = await this.#loadScope(scope, dirPath);
        for (const entry of entries) {
          // 有 key 过滤条件时只返回匹配的
          if (query.key && entry.key !== query.key) continue;
          // 有关键词搜索时做模糊匹配
          if (query.query) {
            const q = query.query.toLowerCase();
            if (
              !entry.content.toLowerCase().includes(q) &&
              !entry.key.toLowerCase().includes(q)
            ) {
              continue;
            }
          }
          results.push(entry);
        }
      } catch {
        continue;
      }
    }

    return results;
  }

  async save(
    input: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">,
  ): Promise<MemoryEntry> {
    const dirPath = this.#basePaths.get(input.scope);
    if (!dirPath) throw new Error(`Unknown memory scope: ${input.scope}`);

    await mkdir(dirPath, { recursive: true });
    const filePath = join(dirPath, `${input.key}.md`);
    await writeFile(filePath, input.content, "utf8");

    const now = new Date().toISOString();
    return {
      id: createRuntimeId("mem"),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
  }

  async delete(id: string): Promise<boolean> {
    for (const dirPath of this.#basePaths.values()) {
      try {
        const files = await readdir(dirPath);
        for (const file of files) {
          if (!file.endsWith(".md")) continue;
          const filePath = join(dirPath, file);
          if (basename(file, ".md").includes(id)) {
            await unlink(filePath);
            return true;
          }
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  listScopes(): MemoryScope[] {
    return [...this.#basePaths.keys()];
  }

  async #loadScope(
    scope: MemoryScope,
    dirPath: string,
  ): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    let files: string[];

    try {
      files = await readdir(dirPath);
    } catch {
      return entries;
    }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      if (PROJECT_INSTRUCTION_FILES.has(file)) continue;

      const filePath = join(dirPath, file);
      try {
        const content = await readFile(filePath, "utf8");
        const key = basename(file, ".md");

        entries.push({
          id: `${scope}:${key}`,
          scope,
          key,
          content,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch {
        continue;
      }
    }

    return entries;
  }
}

/**
 * 自动加载项目说明文件和记忆目录的记忆管理器工厂。
 *
 * 搜索顺序：
 * 1. 项目根目录
 * 2. 项目 .claude/ 目录
 * 3. 用户 ~/.claude/memory/ 目录
 */
export async function createAutoMemoryManager(
  projectRoot: string,
  userHome?: string,
): Promise<MemoryManager> {
  const store = new FileMemoryStore();

  // 项目根目录——这里可以放项目记忆，但不会把项目说明文件当成记忆
  store.addScope("project", projectRoot);

  // 项目 .claude 目录（如果有）
  const projectClaudeDir = join(projectRoot, ".claude");
  store.addScope("local", projectClaudeDir);

  // 用户记忆目录（如果有）
  if (userHome) {
    const userMemoryDir = join(userHome, ".claude", "memory");
    store.addScope("user", userMemoryDir);
  }

  return store;
}
