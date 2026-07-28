// These shared types are the small contract between the agent, models, and tools.
// Keeping them vendor-neutral lets the runtime swap Anthropic for another model later.
import type { MemoryStore } from "../memory/memory-store.js";

export type MessageRole = "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  output: unknown;
  isError?: boolean;
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolResult: ToolResult };

// A tool exposes its model-facing description and its runtime implementation.
// inputSchema intentionally stays unknown so callers may use JSON Schema or a validator.
export interface Tool {
  name: string;
  description: string;
  inputSchema: unknown;
  execute(input: unknown): Promise<unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ModelInput {
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
}

export interface ModelOutput {
  content: string;
  toolCalls: ToolCall[];
  stopReason?: string;
}

// Every model adapter implements this one method. The agent loop therefore has
// no knowledge of API keys, HTTP payloads, or a specific model provider.
export interface ModelProvider {
  generate(input: ModelInput): Promise<ModelOutput>;
}

export interface AgentLoopOptions {
  model: ModelProvider;
  tools?: Tool[];
  systemPrompt?: string;
  maxIterations?: number;
  /** Optional persistent history used to continue the same conversation. */
  sessionStore?: MemoryStore<Message[]>;
}

export interface AgentLoopResult {
  content: string;
  messages: Message[];
  iterations: number;
}
