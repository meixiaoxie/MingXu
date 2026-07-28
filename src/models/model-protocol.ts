export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelRequestMessage {
  role: ModelMessageRole;
  content: string;
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
  name?: string;
  isError?: boolean;
}

export interface ModelRequestTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ModelRequest {
  messages: ModelRequestMessage[];
  tools?: ModelRequestTool[];
  system?: string;
  modelId: string;
  maxTokens?: number;
  temperature?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  stream?: boolean;
  responseFormat?: "text" | "json";
  metadata?: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ModelResponse {
  text: string;
  toolCalls: ModelToolCall[];
  stopReason?: string;
  usage?: ModelUsage;
  refusal?: string;
  errors?: string[];
  rawProviderData?: unknown;
}

export type ModelEvent =
  | { type: "start"; request: ModelRequest }
  | { type: "delta"; text: string }
  | { type: "tool_call"; toolCall: ModelToolCall }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean }
  | { type: "end"; response: ModelResponse }
  | { type: "error"; error: string; rawProviderData?: unknown };
