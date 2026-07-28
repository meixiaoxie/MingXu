import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { agentConfigSchema, type ResolvedAgentConfig } from "./config-schema.js";

/** Loads JSON from disk and returns the same canonical shape as inline config. */
export async function loadConfig(filePath: string): Promise<ResolvedAgentConfig> {
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

  try {
    return agentConfigSchema.parse(rawConfig);
  } catch (error) {
    throw new Error(
      `Invalid config file: ${resolvedPath}\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
