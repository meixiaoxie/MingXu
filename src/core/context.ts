import type { AgentMessage, Message, ToolDefinition, ModelInput } from "./types.js";

/**
 * AgentContext：传给模型的完整上下文。
 * 包含系统提示词、历史消息和可用工具列表。
 * 这个"包裹"准备好后，由 convertToLlm 转成模型能理解的格式。
 */
export interface AgentContext {
  /** 系统提示词（可选）——告诉模型它是什么角色、要遵守什么规则 */
  systemPrompt?: string;
  /** 对话历史，用 runtime 内部的统一消息格式 */
  messages: AgentMessage[];
  /** 当前可用的工具列表 */
  tools: ToolDefinition[];
}

/**
 * TokenBudget：上下文窗口的 token 预算。
 * 和做菜预留调料一样：不能把所有 token 都用来放历史消息，
 * 必须给模型的输出留一些空间（reserveTokens）。
 */
export interface TokenBudget {
  /** 模型支持的最大上下文 token 数 */
  maxContextTokens: number;
  /** 预留给模型输出的 token，这部分不能给消息用 */
  reserveTokens: number;
  /** 当前已用 token 数（可选，后续由 token 估算器填充） */
  usedTokens?: number;
}

/**
 * TransformContext：上下文转换函数。
 * 在发给模型之前，可以对消息列表做裁剪、过滤、重新排序等操作。
 * 后续的 compaction（上下文压缩）就是通过这个管道工作的。
 */
export type TransformContext = (
  messages: AgentMessage[],
  options?: { signal?: AbortSignal; tokenBudget?: TokenBudget },
) => AgentMessage[] | Promise<AgentMessage[]>;

/**
 * ConvertToLlm：把 runtime 内部上下文转成模型层的 ModelInput。
 * 这个"翻译官"负责把 runtime 的统一消息格式转换成具体模型能识别的格式。
 */
export type ConvertToLlm = (
  context: AgentContext,
) => ModelInput | Promise<ModelInput>;

// ============================================================
// 默认实现
// ============================================================

/**
 * 默认上下文转换：不裁剪，原样返回。
 * 后续 compaction 会在这个阶段被调用。
 */
export function defaultTransformContext(messages: AgentMessage[]): AgentMessage[] {
  return [...messages];
}

/** 摘要消息的前缀和后缀，帮助模型识别这是一段压缩后的历史 */
export const SUMMARY_PREFIX = "[Previous conversation summary]\n";
export const SUMMARY_SUFFIX = "\n[End of summary]";

/**
 * 把 runtime 的 AgentMessage 列表转成模型层认识的 ModelInput。
 *
 * 转换规则：
 * - user / assistant / toolResult：直接转换
 * - summary：转成 user 消息，加前缀标记"以下是历史摘要"
 * - system：默认转成 user 消息发给模型，除非 visibleToModel 为 false
 */
export function defaultConvertToLlm(context: AgentContext): ModelInput {
  return {
    messages: context.messages.flatMap(toLegacyMessage),
    ...(context.tools.length > 0 ? { tools: context.tools } : {}),
    ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}),
  };
}

/**
 * 把单条 AgentMessage 转成旧 Message 格式。
 * 因为旧代码（agent-loop.ts 和模型适配器）还依赖旧的 Message 类型，
 * 这个转换让新代码能渐进接入而不破坏旧代码。
 */
function toLegacyMessage(message: AgentMessage): Message[] {
  switch (message.role) {
    case "user":
      return [{ role: "user", content: message.content }];

    case "assistant":
      return [{
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
      }];

    case "toolResult":
      return [{
        role: "tool",
        content: typeof message.toolResult.output === "string"
          ? message.toolResult.output
          : JSON.stringify(message.toolResult.output),
        toolResult: message.toolResult,
      }];

    case "summary":
      // 摘要消息转成 user 角色，让模型知道"这是对之前对话的总结"
      return [{
        role: "user",
        content: `${SUMMARY_PREFIX}${message.content}${SUMMARY_SUFFIX}`,
      }];

    case "system":
      // visibleToModel 为 false 的系统消息不发给模型（比如 UI 调试信息）
      return message.visibleToModel === false
        ? []
        : [{ role: "user", content: message.content }];
  }
}
