import type { AgentMessage } from "../core/types.js";

/**
 * 摘要生成器接口。
 * 接收一批要归档的消息，返回一段摘要文本。
 */
export type SummaryGenerator = (
  messages: AgentMessage[],
  options?: { signal?: AbortSignal },
) => Promise<string>;

/**
 * 默认摘要生成器：简单拼接消息内容。
 * 不需要单独调模型——把要归档的消息内容按角色分类拼成文本即可。
 * 后续可接入模型生成更智能的摘要。
 */
export const defaultSummaryGenerator: SummaryGenerator = async (messages) => {
  const text = messages
    .filter((m) => m.role !== "system" || m.visibleToModel !== false)
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n\n");

  // 截断避免摘要本身太大（16k 字符）
  return text.slice(0, 16_000);
};

/**
 * 使用模型生成摘要的工厂函数。
 * 当有 streamFn 时，可以调模型生成更精准的摘要。
 * 如果模型摘要失败，自动回退到简单拼接。
 */
export function createModelSummaryGenerator(
  streamFn?: (prompt: string) => Promise<string>,
): SummaryGenerator {
  if (!streamFn) return defaultSummaryGenerator;

  return async (messages, options) => {
    const text = messages
      .filter((m) => m.role !== "system" || m.visibleToModel !== false)
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n\n")
      .slice(0, 32_000);

    if (options?.signal?.aborted) {
      throw new Error("Summary generation aborted");
    }

    try {
      return await streamFn(
        `Please summarize the following conversation. Focus on key decisions, facts, and context:\n\n${text}`,
      );
    } catch {
      // 模型摘要失败时回退到简单拼接
      return text.slice(0, 8_000);
    }
  };
}
