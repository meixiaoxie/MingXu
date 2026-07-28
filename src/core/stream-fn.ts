import type { AgentContext } from "./context.js";
import type { AgentMessage, ModelProvider, ToolCall } from "./types.js";
import { defaultConvertToLlm } from "./context.js";
import { createRuntimeId } from "./runtime-id.js";
import type { AssistantStreamEvent, StreamFn, StreamOptions } from "./stream-types.js";

/**
 * 当模型 adapter 只有 generate（一次性返回）没有 stream（流式返回）时，
 * 用这个 fallback 把 generate 的结果切成块，模拟成流式事件。
 *
 * 为什么要这样做？因为 runtime 层统一用 streamFn() 调用模型。
 * 如果每个调用点都要判断"这个模型支持流吗？不支持我就用 generate"，
 * 代码会很乱。把这个判断封装在 fallback 里，runtime 层不需要知道
 * 底层是什么能力。
 */
export function createGenerateFallbackStreamFn(
  modelProvider: ModelProvider,
): StreamFn {
  const streamFn: StreamFn = async function* generateFallbackStream(
    _model: string,
    context: AgentContext,
    options?: StreamOptions,
  ): AsyncIterable<AssistantStreamEvent> {
    // 在开始之前就检查是否已被取消，避免浪费模型调用
    if (options?.signal?.aborted) {
      yield { type: "error", error: "Aborted before model call" };
      return;
    }

    // 把 AgentContext 转成旧的 ModelInput，因为 generate 接口还是旧的
    const modelInput = await defaultConvertToLlm(context);
    const output = await modelProvider.generate(modelInput);
    const messageId = createRuntimeId("assistant");

    // 先发 start 事件
    yield { type: "start", messageId };

    // 把完整输出切成小块，每块最多 50 个字符，
    // 这样 UI 能显示逐字输出的效果，虽然实际上是一次性返回的
    if (output.content) {
      const chunks = splitTextIntoChunks(output.content, 50);
      for (const chunk of chunks) {
        yield { type: "text_delta", text: chunk };
      }
    }

    // 逐个发送工具调用
    for (const toolCall of output.toolCalls) {
      yield { type: "tool_call", toolCall };
    }

    // 组装完整的 assistant 消息
    const message: AgentMessage = {
      id: messageId,
      role: "assistant",
      content: output.content,
      createdAt: new Date().toISOString(),
      ...(output.toolCalls.length > 0 ? { toolCalls: output.toolCalls } : {}),
      ...(output.stopReason !== undefined ? { stopReason: output.stopReason } : {}),
    };

    // 最后发 done 事件，携带完整消息
    yield { type: "done", message };
  };

  return streamFn;
}

/**
 * 把长文本切成小块，模拟流式输出的效果。
 * 按字符切而非按词切，因为中文没有空格分词。
 */
function splitTextIntoChunks(text: string, maxChunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChunkSize) {
    chunks.push(text.slice(i, i + maxChunkSize));
  }
  return chunks;
}
