import { Agent } from "../core/agent.js";
import type { AgentConfig } from "../config/config-schema.js";
import { loadConfig } from "../config/load-config.js";
import { ProviderRegistry } from "../models/provider-registry.js";
import { registerBuiltinProviders } from "../models/provider-catalog.js";
import { createRuntimeModelProvider } from "../models/model-runtime.js";
import { parseArgs } from "./parse-args.js";

export interface CliDependencies {
  run?: (config: AgentConfig, prompt?: string) => Promise<string | void>;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  version?: string;
}

const HELP_TEXT = `Usage: mingxu [options] [prompt]\n\nOptions:\n  -c, --config <path>  JSON configuration file\n  -p, --prompt <text>  Prompt to send to the agent\n  -h, --help           Show this help\n  -v, --version        Show the version\n`;

export async function main(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  try {
    const args = parseArgs(argv);
    if (args.help) {
      stdout.write(HELP_TEXT);
      return 0;
    }
    if (args.version) {
      stdout.write(`${dependencies.version ?? "development"}\n`);
      return 0;
    }

    const config = await loadConfig(args.configPath);
    const run = dependencies.run ?? createDefaultRunner();
    const result = await run(config, args.prompt);
    if (result !== undefined) stdout.write(`${result}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

function createDefaultRunner(): NonNullable<CliDependencies["run"]> {
  return async (config, prompt) => {
    const agentPrompt = prompt?.trim();
    if (!agentPrompt) {
      throw new Error("A prompt is required");
    }

    const registry = registerBuiltinProviders(new ProviderRegistry());
    const runtimeModel = createRuntimeModelProvider(registry.create(config.model), config.model);
    const agent = new Agent({
      model: runtimeModel,
      ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
      maxIterations: config.maxIterations,
    });
    const result = await agent.run(agentPrompt);
    return result.content;
  };
}
