import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SystemPromptInput {
  baseSystemPrompt?: string;
  projectRoot?: string;
}

/**
 * 组装增强版系统提示词。
 *
 * 结构：
 * 1. 基础系统提示词
 * 2. CLAUDE.md 内容（如果有）
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const parts: string[] = [];

  if (input.baseSystemPrompt) {
    parts.push(input.baseSystemPrompt);
  }

  return parts.join("\n\n---\n\n");
}

/**
 * 异步加载 CLAUDE.md 内容。
 * 文件不存在时返回 undefined（不抛错）。
 */
export async function loadClaudeMd(
  projectRoot: string,
): Promise<string | undefined> {
  try {
    const claudeMdPath = join(projectRoot, "CLAUDE.md");
    const content = await readFile(claudeMdPath, "utf8");
    return content;
  } catch {
    return undefined;
  }
}
