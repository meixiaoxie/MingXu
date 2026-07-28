import { mkdir, appendFile, readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { JsonlSessionStore as JsonlSessionStoreInterface } from "./jsonl-session-types.js";
import type { SessionEntry } from "./session-entry.js";

/**
 * JSONL session store: append-only session storage.
 *
 * Each record occupies one line in the JSONL file.
 * Append writes are safe even on crash - already written lines are not lost.
 * Write operations use a serial queue to prevent interleaved lines from concurrent appends.
 */
export class JsonlSessionStore implements JsonlSessionStoreInterface {
  readonly #filePath: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    if (!filePath.trim()) throw new Error("Session file path cannot be empty");
    this.#filePath = resolve(filePath);
  }

  async append(entry: SessionEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    this.#writeQueue = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#filePath), { recursive: true });
      await appendFile(this.#filePath, line, "utf8");
    });
    return this.#writeQueue;
  }

  async load(sessionId: string): Promise<SessionEntry[]> {
    const text = await this.#readIfExists();
    const entries: SessionEntry[] = [];

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const entry = JSON.parse(trimmed) as SessionEntry;
        if (entry.sessionId === sessionId) {
          entries.push(entry);
        }
      } catch {
        continue;
      }
    }

    return entries;
  }

  async getAncestorChain(entryId: string): Promise<SessionEntry[]> {
    const allEntries = await this.#readAll();
    const byId = new Map(allEntries.map((e) => [e.id, e]));

    const chain: SessionEntry[] = [];
    let current = byId.get(entryId);

    while (current) {
      chain.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }

    return chain;
  }

  async getChildren(parentId: string): Promise<SessionEntry[]> {
    const allEntries = await this.#readAll();
    return allEntries.filter((e) => e.parentId === parentId);
  }

  async getLeaves(sessionId: string): Promise<SessionEntry[]> {
    const entries = await this.load(sessionId);
    return entries.filter(
      (e) => !entries.some((child) => child.parentId === e.id),
    );
  }

  async getLatestLeaf(sessionId: string): Promise<SessionEntry | undefined> {
    const entries = await this.load(sessionId);
    if (entries.length === 0) return undefined;

    const leaves = entries.filter(
      (e) => !entries.some((child) => child.parentId === e.id),
    );
    leaves.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return leaves[0];
  }

  async clear(_sessionId: string): Promise<void> {
    await writeFile(this.#filePath, "", "utf8");
  }

  async #fileExists(): Promise<boolean> {
    try {
      await access(this.#filePath);
      return true;
    } catch {
      return false;
    }
  }

  async #readIfExists(): Promise<string> {
    if (!(await this.#fileExists())) return "";
    return readFile(this.#filePath, "utf8");
  }

  async #readAll(): Promise<SessionEntry[]> {
    const text = await this.#readIfExists();
    const entries: SessionEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch {
        continue;
      }
    }
    return entries;
  }
}
