import type { AgentMessage } from "../core/types.js";
import { defaultTransformContext, type TokenBudget, type TransformContext } from "../core/context.js";
import { compactMessages, type CompactionSettings } from "./compaction.js";
import type { SummaryGenerator } from "./summary-generator.js";
import { createOverflowRecoverySettings } from "./overflow-recovery.js";

export interface CompactionOrchestratorOptions {
  settings?: CompactionSettings;
  baseTransformContext?: TransformContext;
  summaryGenerator?: SummaryGenerator;
  overflow?: boolean;
}

/**
 * 先执行原本的上下文转换，再按压缩配置裁剪历史。
 * 这样用户自定义的 transformContext 仍然有效，压缩只是叠加在它后面。
 */
export function createCompactionTransformContext(
  options: CompactionOrchestratorOptions = {},
): TransformContext {
  const baseTransformContext = options.baseTransformContext ?? defaultTransformContext;

  return async (
    messages: AgentMessage[],
    transformOptions?: { signal?: AbortSignal; tokenBudget?: TokenBudget },
  ) => {
    const transformed = await baseTransformContext(messages, transformOptions);
    if (!options.settings?.enabled) {
      return transformed;
    }

    const settings = options.overflow
      ? createOverflowRecoverySettings(options.settings)
      : options.settings;

    const result = await compactMessages(
      transformed,
      settings,
      options.summaryGenerator,
    );
    return result.messages;
  };
}
