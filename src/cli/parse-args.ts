export interface CliArguments {
  readonly configPath: string;
  readonly model: string | undefined;
  readonly prompt: string | undefined;
  readonly help: boolean;
  readonly version: boolean;
}

/** Parses a deliberately small CLI surface without requiring a command-line package. */
export function parseArgs(argv: readonly string[]): CliArguments {
  let configPath = "mingxu.config.json";
  let model: string | undefined;
  let prompt: string | undefined;
  let help = false;
  let version = false;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--version" || argument === "-v") {
      version = true;
    } else if (argument === "--config" || argument === "-c") {
      configPath = readOptionValue(argv, ++index, argument);
    } else if (argument === "--model") {
      model = readOptionValue(argv, ++index, argument);
    } else if (argument === "--prompt" || argument === "-p") {
      prompt = readOptionValue(argv, ++index, argument);
    } else if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (argument !== undefined) {
      positionals.push(argument);
    }
  }

  if (prompt !== undefined && positionals.length > 0) {
    throw new Error("Provide a prompt either positionally or with --prompt, not both");
  }

  const positionalPrompt = positionals.length > 0 ? positionals.join(" ") : undefined;
  return {
    configPath,
    model,
    prompt: prompt ?? positionalPrompt,
    help,
    version,
  };
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index];
  // A following option is not a value. Prompts beginning with '-' can still be
  // passed positionally after the conventional '--' separator.
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}
