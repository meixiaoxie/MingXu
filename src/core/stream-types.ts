import type { AgentMessage, ToolCall } from "./types.js";
import type { AgentContext } from "./context.js";

/**
 * StreamOptions：传给 streamFn 的额外参数。
 */
export interface StreamOptions {
  /** 取消信号——用户点了"停止"就通过这个传进来 */
  signal?: AbortSignal;
  /** 模型最大输出 token 数 */
  maxTokens?: number;
  /** 模型温度（控制随机性，越高越"有创意"） */
  temperature?: number;
  /** 额外的元数据，透传给 provider */
  metadata?: Record<string, unknown>;
}

/**
 * AssistantStreamEvent：模型回复的流式事件。
 *
 * 类比：就像看视频时逐帧加载——不用等整个视频下载完才能看到第一帧。
 * 流式也一样，模型每吐出几个字就发一个 text_delta 事件，
 * UI 可以立刻显示，不用等完整回复。
 *
 * 事件顺序保证：start → (text_delta | tool_call)* → done
 */
export type AssistantStreamEvent =
  | { type: "start"; messageId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "done"; message: AgentMessage }
  | { type: "error"; error: string };

/**
 * StreamFn：统一的流式函数入口。
 *
 * 不管底层模型是真正的流式 API 还是模拟的，runtime 只调这一个函数。
 * 这就是"依赖倒置"——runtime 不关心具体实现，只关心这个接口。
 *
 * @param model - 模型标识符
 * @param context - 当前上下文（消息 + 工具 + 系统提示词）
 * @param options - 可选参数（取消信号、温度等）
 * @returns 异步可迭代的事件流
 */
export type StreamFn = (
  model: string,
  context: AgentContext,
  options?: StreamOptions,
) => AsyncIterable<AssistantStreamEvent> | Promise<AsyncIterable<AssistantStreamEvent>>;
