/** Minimal asynchronous key-value contract shared by all memory backends. */
export interface MemoryStore<T = unknown> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export function assertMemoryKey(key: string): void {
  if (!key.trim()) {
    throw new Error("Memory key cannot be empty");
  }
}
