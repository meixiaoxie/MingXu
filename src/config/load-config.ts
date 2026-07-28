import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { agentConfigSchema, type AgentConfig } from "./config-schema.js";

/** Loads a JSON file from disk and validates it before it reaches the runtime. */
export async function loadConfig(filePath: string): Promise<AgentConfig> {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) {
    throw new Error("Config file path cannot be empty");
  }

  // Resolving once gives read and validation errors one stable, unambiguous path.
  const resolvedPath = resolve(trimmedPath);
  let source: string;
  try {
    source = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read config file: ${resolvedPath}`, { cause: error });
  }

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Config file is not valid JSON: ${resolvedPath}`, { cause: error });
  }

  const result = agentConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    throw new Error(
      `Invalid config file: ${resolvedPath}\n${result.error.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}
