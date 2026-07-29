import type { MemoryEntry, MemoryQuery, MemoryScope } from "./memory-scope.js";

export interface MemoryManager {
  query(query: MemoryQuery): Promise<MemoryEntry[]>;
  save(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry>;
  delete(id: string): Promise<boolean>;
  listScopes(): MemoryScope[];
}
