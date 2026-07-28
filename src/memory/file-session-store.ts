import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { assertMemoryKey, type MemoryStore } from "./memory-store.js";

type SessionData<T> = Record<string, T>;

/**
 * Persists one session as JSON. Writes use a temporary file then rename it so a
 * stopped process is less likely to leave partially written session data.
 */
export class FileSessionStore<T = unknown> implements MemoryStore<T> {
  readonly #filePath: string;
  #operation: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    if (!filePath.trim()) {
      throw new Error("Session file path cannot be empty");
    }
    this.#filePath = resolve(filePath);
  }

  async get(key: string): Promise<T | undefined> {
    assertMemoryKey(key);
    return this.#run(async () => (await this.#read())[key]);
  }

  async set(key: string, value: T): Promise<void> {
    assertMemoryKey(key);
    await this.#run(async () => {
      const data = await this.#read();
      data[key] = value;
      await this.#write(data);
    });
  }

  async delete(key: string): Promise<boolean> {
    assertMemoryKey(key);
    return this.#run(async () => {
      const data = await this.#read();
      if (!Object.hasOwn(data, key)) return false;
      delete data[key];
      await this.#write(data);
      return true;
    });
  }

  async keys(): Promise<string[]> {
    return this.#run(async () => Object.keys(await this.#read()));
  }

  async clear(): Promise<void> {
    await this.#run(async () => {
      await rm(this.#filePath, { force: true });
    });
  }

  /** Serializing operations prevents two updates from silently overwriting each other. */
  async #run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async #read(): Promise<SessionData<T>> {
    try {
      const source = await readFile(this.#filePath, "utf8");
      const parsed: unknown = JSON.parse(source);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Session data must be a JSON object");
      }
      return parsed as SessionData<T>;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return {};
      throw new Error(`Failed to read session file: ${this.#filePath}`, { cause: error });
    }
  }

  async #write(data: SessionData<T>): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.#filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw new Error(`Failed to write session file: ${this.#filePath}`, { cause: error });
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
