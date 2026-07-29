import { z } from "zod";

import { defineTool, type RuntimeTool } from "../tool.js";
import type { MemoryEntry, MemoryQuery, MemoryScope } from "../../memory/memory-scope.js";
import type { MemoryManager } from "../../memory/memory-manager.js";

const memoryScopeSchema = z.enum(["managed", "user", "project", "local"]);

const memoryQuerySchema = z.object({
  scope: memoryScopeSchema.optional(),
  key: z.string().trim().min(1).optional(),
  query: z.string().trim().min(1).optional(),
}).strict();

const memorySaveSchema = z.object({
  scope: memoryScopeSchema,
  key: z.string().trim().min(1),
  content: z.string(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

const memoryDeleteSchema = z.object({
  id: z.string().trim().min(1),
}).strict();

export function createMemorySearchTool(memoryManager: MemoryManager): RuntimeTool<z.infer<typeof memoryQuerySchema>, MemoryEntry[]> {
  return defineTool({
    name: "memory_search",
    description: "Search long-term memory within the configured scopes.",
    inputSchema: memoryQuerySchema,
    riskLevel: "low",
    async execute(input, context) {
      context?.signal?.throwIfAborted();
      return memoryManager.query(input as MemoryQuery);
    },
  });
}

export function createMemorySaveTool(memoryManager: MemoryManager): RuntimeTool<z.infer<typeof memorySaveSchema>, MemoryEntry> {
  return defineTool({
    name: "memory_save",
    description: "Save a long-term memory entry explicitly.",
    inputSchema: memorySaveSchema,
    riskLevel: "high",
    async execute(input, context) {
      context?.signal?.throwIfAborted();
      const { metadata, ...rest } = input;
      return memoryManager.save({
        ...rest,
        ...(metadata !== undefined ? { metadata } : {}),
      });
    },
  });
}

export function createMemoryDeleteTool(memoryManager: MemoryManager): RuntimeTool<z.infer<typeof memoryDeleteSchema>, boolean> {
  return defineTool({
    name: "memory_delete",
    description: "Delete a long-term memory entry explicitly.",
    inputSchema: memoryDeleteSchema,
    riskLevel: "high",
    async execute(input, context) {
      context?.signal?.throwIfAborted();
      return memoryManager.delete(input.id);
    },
  });
}
