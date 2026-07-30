export interface CliArguments {
  readonly configPath: string;
  readonly configProvided: boolean;
  readonly model: string | undefined;
  readonly prompt: string | undefined;
  readonly help: boolean;
  readonly version: boolean;
  readonly command?: "resume" | "sessions" | "init" | "doctor" | "chat" | "extensions";
  readonly commandTarget?: string;
  readonly commandArgs?: readonly string[];
  readonly profile?: "minimal" | "secure-local";
  readonly initScope?: "global" | "project";
  readonly online?: boolean;
  readonly debugProvider?: boolean;
  readonly continueMode?: boolean;
  readonly yes?: boolean;
  readonly scope?: "user" | "project";
  readonly noGlobalConfig?: boolean;
  readonly trustProject?: boolean;
  readonly noTrustProject?: boolean;
  readonly temporary?: boolean;
}

/** Parses a deliberately small CLI surface without requiring a command-line package. */
export function parseArgs(argv: readonly string[]): CliArguments {
  let configPath = "mingxu.config.json";
  let configProvided = false;
  let model: string | undefined;
  let prompt: string | undefined;
  let help = false;
  let version = false;
  let command: CliArguments["command"];
  let commandTarget: string | undefined;
  let commandArgs: string[] = [];
  let profile: CliArguments["profile"];
  let initScope: CliArguments["initScope"];
  let online = false;
  let debugProvider = false;
  let continueMode = false;
  let yes = false;
  let scope: CliArguments["scope"];
  let noGlobalConfig = false;
  let trustProject = false;
  let noTrustProject = false;
  let temporary = false;
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
    } else if (argument === "chat") {
      command = "chat";
    } else if (argument === "extensions") {
      command = "extensions";
    } else if (argument === "--profile") {
      const value = readOptionValue(argv, ++index, argument);
      if (value !== "minimal" && value !== "secure-local") {
        throw new Error(`Unsupported profile: ${value}`);
      }
      profile = value;
    } else if (argument === "--global") {
      initScope = "global";
    } else if (argument === "--project") {
      initScope = "project";
    } else if (argument === "--online") {
      online = true;
    } else if (argument === "--debug-provider") {
      debugProvider = true;
    } else if (argument === "--continue") {
      continueMode = true;
    } else if (argument === "--yes" || argument === "-y") {
      yes = true;
    } else if (argument === "--scope") {
      const value = readOptionValue(argv, ++index, argument);
      if (value !== "user" && value !== "project") {
        throw new Error(`Unsupported scope: ${value}`);
      }
      scope = value;
    } else if (argument === "--no-global-config") {
      noGlobalConfig = true;
    } else if (argument === "--trust-project") {
      trustProject = true;
    } else if (argument === "--no-trust-project") {
      noTrustProject = true;
    } else if (argument === "--temporary") {
      temporary = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--version" || argument === "-v") {
      version = true;
    } else if (argument === "--config" || argument === "-c") {
      configPath = readOptionValue(argv, ++index, argument);
      configProvided = true;
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
  if (command === "extensions") {
    commandTarget = positionals[0];
    commandArgs = positionals.slice(1);
  }
  return {
    configPath,
    configProvided,
    model,
    prompt: prompt ?? positionalPrompt,
    help,
    version,
    ...(command !== undefined ? { command } : {}),
    ...(commandTarget !== undefined ? { commandTarget } : {}),
    ...(commandArgs.length > 0 ? { commandArgs } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(initScope !== undefined ? { initScope } : {}),
    ...(online ? { online } : {}),
    ...(debugProvider ? { debugProvider } : {}),
    ...(continueMode ? { continueMode } : {}),
    ...(yes ? { yes } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(noGlobalConfig ? { noGlobalConfig } : {}),
    ...(trustProject ? { trustProject } : {}),
    ...(noTrustProject ? { noTrustProject } : {}),
    ...(temporary ? { temporary } : {}),
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
