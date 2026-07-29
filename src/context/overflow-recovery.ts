import type { CompactionSettings } from "./compaction.js";

const OVERFLOW_HINTS = [
  "context",
  "token",
  "max_tokens",
  "max tokens",
  "overflow",
  "too long",
];

/**
 * 判断这是不是一次上下文溢出。
 * 这里同时看错误对象和错误文本，兼容不同 provider 的报错风格。
 */
export function isContextOverflowError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "").toLowerCase();
    if (code === "context_limit") return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return OVERFLOW_HINTS.some((hint) => lowered.includes(hint));
}

/**
 * 上下文溢出时的更激进压缩参数。
 * 这次会更狠一点，尽量把尾巴再收短一些，换一次重试机会。
 */
export function createOverflowRecoverySettings(
  settings: CompactionSettings,
): CompactionSettings {
  return {
    ...settings,
    reserveTokens: Math.max(1_000, Math.floor(settings.reserveTokens * 0.5)),
    keepRecentTokens: Math.max(2_000, Math.floor(settings.keepRecentTokens * 0.75)),
  };
}
