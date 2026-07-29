/**
 * MemoryScope defines the persistence tier for long-term memory.
 *
 * - managed: host-managed, read-only memory
 * - user: user-wide memory
 * - project: project-wide memory
 * - local: working-directory memory
 */
export type MemoryScope = "managed" | "user" | "project" | "local";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  key: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  scope?: MemoryScope;
  key?: string;
  query?: string;
}
