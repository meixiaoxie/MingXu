import { readFile, mkdir, readdir, writeFile, unlink, lstat } from "node:fs/promises";
import { join, basename } from "node:path";

import { createRuntimeId } from "../core/runtime-id.js";
import { assertSafeStorageTarget, resolveSafeStoragePath } from "../storage/safe-storage-path.js";
import type { MemoryEntry, MemoryQuery, MemoryScope } from "./memory-scope.js";
import type { MemoryManager } from "./memory-manager.js";

const PROJECT_INSTRUCTION_FILES = new Set(["MINGXU.md", "CLAUDE.md", "AGENTS.md"]);

export class FileMemoryStore implements MemoryManager {
  readonly #basePaths = new Map<MemoryScope, string>();
  readonly #readOnlyScopes = new Set<MemoryScope>();

  constructor(
    basePaths: Partial<Record<MemoryScope, string>> = {},
    options: { readonlyScopes?: readonly MemoryScope[] } = {},
  ) {
    for (const [scope, path] of Object.entries(basePaths)) {
      if (path) this.#basePaths.set(scope as MemoryScope, path);
    }
    for (const scope of options.readonlyScopes ?? []) {
      this.#readOnlyScopes.add(scope);
    }
  }

  addScope(scope: MemoryScope, path: string): void {
    this.#basePaths.set(scope, path);
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];
    const scopes = query.scope ? [query.scope] : [...this.#basePaths.keys()];

    for (const scope of scopes) {
      const dirPath = this.#basePaths.get(scope);
      if (!dirPath) continue;

      try {
        const entries = await this.#loadScope(scope, dirPath);
        for (const entry of entries) {
          if (query.key && entry.key !== query.key) continue;
          if (query.query) {
            const q = query.query.toLowerCase();
            if (!entry.content.toLowerCase().includes(q) && !entry.key.toLowerCase().includes(q)) {
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

  async save(input: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry> {
    const dirPath = this.#basePaths.get(input.scope);
    if (!dirPath) throw new Error(`Unknown memory scope: ${input.scope}`);
    if (this.#readOnlyScopes.has(input.scope)) {
      throw new Error(`Memory scope is read-only: ${input.scope}`);
    }

    await mkdir(dirPath, { recursive: true });
    const filePath = resolveSafeStoragePath(dirPath, input.key, ".md", "Memory key");
    await assertSafeStorageTarget(dirPath, filePath);
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
    for (const [scope, dirPath] of this.#basePaths.entries()) {
      if (this.#readOnlyScopes.has(scope)) continue;
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

  async #loadScope(scope: MemoryScope, dirPath: string): Promise<MemoryEntry[]> {
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
        if ((await lstat(filePath)).isSymbolicLink()) continue;
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

export async function createAutoMemoryManager(
  projectRoot: string,
  userHome?: string,
  managedRoot?: string,
): Promise<MemoryManager> {
  const store = new FileMemoryStore({}, { readonlyScopes: managedRoot ? ["managed"] : [] });

  store.addScope("project", projectRoot);

  const projectClaudeDir = join(projectRoot, ".claude");
  store.addScope("local", projectClaudeDir);

  if (userHome) {
    const userMemoryDir = join(userHome, ".claude", "memory");
    store.addScope("user", userMemoryDir);
  }

  if (managedRoot) {
    store.addScope("managed", managedRoot);
  }

  return store;
}
