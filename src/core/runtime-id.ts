/**
 * 递增式 ID 生成器。
 *
 * 测试环境中用简单的递增计数器，确保 ID 可预测；
 * 生产环境中可替换为 UUID。
 */

let counter = 0;

/** 生成带前缀的递增 ID，例如 createRuntimeId("assistant") → "assistant-1" */
export function createRuntimeId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** 测试专用：重置计数器，让 ID 从头开始 */
export function resetRuntimeIdCounter(): void {
  counter = 0;
}
