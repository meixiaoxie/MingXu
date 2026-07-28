import { assertMemoryKey, type MemoryStore } from "./memory-store.js";

/** Fast process-local memory. Values disappear when the process exits. */
export class InMemoryStore<T = unknown> implements MemoryStore<T> {
  readonly #values = new Map<string, T>();

  async get(key: string): Promise<T | undefined> {
    assertMemoryKey(key);
    return this.#values.get(key);
  }

  async set(key: string, value: T): Promise<void> {
    assertMemoryKey(key);
    this.#values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    assertMemoryKey(key);
    return this.#values.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.#values.keys()];
  }

  async clear(): Promise<void> {
    this.#values.clear();
  }
}
