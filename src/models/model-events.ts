import type { ModelEvent, ModelRequest, ModelResponse } from "./model-protocol.js";

export function createModelStartEvent(request: ModelRequest): ModelEvent {
  return { type: "start", request };
}

export function createModelEndEvent(response: ModelResponse): ModelEvent {
  return { type: "end", response };
}

export function createModelErrorEvent(error: unknown, rawProviderData?: unknown): ModelEvent {
  return {
    type: "error",
    error: error instanceof Error ? error.message : String(error),
    ...(rawProviderData !== undefined ? { rawProviderData } : {}),
  };
}
