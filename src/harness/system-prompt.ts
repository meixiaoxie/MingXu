import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PROJECT_INSTRUCTION_FILES = ["MINGXU.md", "CLAUDE.md"] as const;

export interface SystemPromptInput {
  baseSystemPrompt?: string;
  projectRoot?: string;
  autoLoadClaudeMd?: boolean;
}

export async function buildSystemPrompt(input: SystemPromptInput): Promise<string> {
  const parts: string[] = [];

  if (input.baseSystemPrompt) {
    parts.push(input.baseSystemPrompt);
  }

  if (input.projectRoot && input.autoLoadClaudeMd !== false) {
    const projectInstructions = await loadClaudeMd(input.projectRoot);
    if (projectInstructions && projectInstructions.trim()) {
      parts.push(projectInstructions);
    }
  }

  return parts.join("\n\n---\n\n");
}

export async function loadClaudeMd(projectRoot: string): Promise<string | undefined> {
  for (const fileName of PROJECT_INSTRUCTION_FILES) {
    try {
      const content = await readFile(join(projectRoot, fileName), "utf8");
      if (content.trim()) {
        return content;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}
