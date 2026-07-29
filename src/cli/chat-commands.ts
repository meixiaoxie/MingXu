export interface ChatCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly usage: string;
  readonly description: string;
}

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  {
    name: "help",
    aliases: ["?"],
    usage: "/help",
    description: "Show available chat commands.",
  },
  {
    name: "status",
    aliases: [],
    usage: "/status",
    description: "Show the current session and model status.",
  },
  {
    name: "model",
    aliases: [],
    usage: "/model [key]",
    description: "Show or switch the active model.",
  },
  {
    name: "tools",
    aliases: [],
    usage: "/tools",
    description: "List the tools currently available to the agent.",
  },
  {
    name: "session",
    aliases: [],
    usage: "/session",
    description: "Show the current session id.",
  },
  {
    name: "sessions",
    aliases: [],
    usage: "/sessions",
    description: "List recent saved sessions.",
  },
  {
    name: "resume",
    aliases: [],
    usage: "/resume [id]",
    description: "Resume a saved session or pick from recent sessions.",
  },
  {
    name: "new",
    aliases: [],
    usage: "/new",
    description: "Start a fresh session without leaving chat mode.",
  },
  {
    name: "clear",
    aliases: [],
    usage: "/clear",
    description: "Clear the visible terminal output.",
  },
  {
    name: "exit",
    aliases: ["quit"],
    usage: "/exit",
    description: "Exit chat mode.",
  },
] as const;

export function formatChatHelp(): string {
  return [
    "Commands:",
    ...CHAT_COMMANDS.map((command) => `${command.usage.padEnd(18)} ${command.description}`),
  ].join("\n");
}

export function findChatCommand(input: string): ChatCommand | undefined {
  const normalized = input.trim().replace(/^\/+/u, "");
  if (!normalized) return undefined;
  return CHAT_COMMANDS.find((command) =>
    command.name === normalized || command.aliases.includes(normalized));
}

export function suggestChatCommands(prefix: string): readonly ChatCommand[] {
  const normalized = prefix.trim().replace(/^\/+/u, "");
  if (!normalized) return CHAT_COMMANDS;

  return CHAT_COMMANDS.filter((command) =>
    command.name.startsWith(normalized)
    || command.aliases.some((alias) => alias.startsWith(normalized)),
  );
}

export function commandName(command: ChatCommand): string {
  return command.name;
}
