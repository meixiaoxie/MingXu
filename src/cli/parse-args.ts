export interface CliArguments {
  readonly configPath: string;
  readonly model: string | undefined;
  readonly prompt: string | undefined;
  readonly help: boolean;
  readonly version: boolean;
  readonly command?: "resume" | "sessions" | "init" | "doctor";
  readonly commandTarget?: string;
  readonly profile?: "minimal" | "secure-local";
  readonly online?: boolean;
  readonly debugProvider?: boolean;
}

/** Parses a deliberately small CLI surface without requiring a command-line package. */
export function parseArgs(argv: readonly string[]): CliArguments {
  let configPath = "mingxu.config.json";
  let model: string | undefined;
  let prompt: string | undefined;
  let help = false;
  let version = false;
  let command: CliArguments["command"];
  let commandTarget: string | undefined;
  let profile: CliArguments["profile"];
  let online = false;
  let debugProvider = false;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "resume") {
      command = "resume";
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        commandTarget = next;
        index += 1;
      }
    } else if (argument === "sessions") {
      command = "sessions";
    } else if (argument === "init") {
      command = "init";
    } else if (argument === "doctor") {
      command = "doctor";
    } else if (argument === "--profile") {
      const value = readOptionValue(argv, ++index, argument);
      if (value !== "minimal" && value !== "secure-local") {
        throw new Error(`Unsupported profile: ${value}`);
      }
      profile = value;
    } else if (argument === "--online") {
      online = true;
    } else if (argument === "--debug-provider") {
      debugProvider = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--version" || argument === "-v") {
      version = true;
    } else if (argument === "--config" || argument === "-c") {
      configPath = readOptionValue(argv, ++index, argument);
    } else if (argument === "--model") {
      model = readOptionValue(argv, ++index, argument);
    } else if (argument === "--prompt" || argument === "-p") {
      prompt = readOptionValue(argv, ++index, argument);
    } else if (argument === "--model" || argument === "-m") {
      model = readOptionValue(argv, ++index, argument);
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
    ...(command !== undefined ? { command } : {}),
    ...(commandTarget !== undefined ? { commandTarget } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(online ? { online } : {}),
    ...(debugProvider ? { debugProvider } : {}),
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
