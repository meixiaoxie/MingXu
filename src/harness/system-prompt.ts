export interface SystemPromptInput {
  baseSystemPrompt?: string;
  projectRoot?: string;
  autoLoadClaudeMd?: boolean;
}

export async function buildSystemPrompt(input: SystemPromptInput): Promise<string> {
  const { InstructionLoader } = await import("../instructions/instruction-loader.js");
  const includeProjectInstructions = input.autoLoadClaudeMd !== false;
  return new InstructionLoader({
    ...(input.baseSystemPrompt !== undefined ? { systemPrompt: input.baseSystemPrompt } : {}),
    ...(input.projectRoot !== undefined && includeProjectInstructions ? { project: { dir: input.projectRoot } } : {}),
    ...(input.autoLoadClaudeMd !== undefined ? { autoLoadClaudeMd: input.autoLoadClaudeMd } : {}),
  }).build();
}

export async function loadClaudeMd(projectRoot: string): Promise<string | undefined> {
  const prompt = await buildSystemPrompt({ projectRoot });
  return prompt.trim() ? prompt : undefined;
}
