import { defaultConvertToLlm } from "./context.js";
import type { AssistantStreamEvent, StreamFn } from "./stream-types.js";
import type { ModelProvider } from "./types.js";
import { createRuntimeId } from "./runtime-id.js";

export function createGenerateFallbackStreamFn(model: ModelProvider): StreamFn {
  return async function* generateFallbackStream(_model, context, options): AsyncIterable<AssistantStreamEvent> {
    if (options?.signal?.aborted) {
      yield { type: "error", error: "Aborted before model call" };
      return;
    }

    const input = defaultConvertToLlm(context);
    const response = await model.generate(input);

    const messageId = createRuntimeId("assistant");
    yield { type: "start", messageId };
    if (response.content) {
      yield { type: "text_delta", text: response.content };
    }
    for (const toolCall of response.toolCalls) {
      yield { type: "tool_call", toolCall };
    }
    yield {
      type: "done",
      message: {
        id: messageId,
        role: "assistant",
        content: response.content,
        createdAt: new Date().toISOString(),
        ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
      },
    };
  };
}
