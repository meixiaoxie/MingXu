import type { ChatCommand } from "./chat-commands.js";

export interface ParsedCommand {
  readonly raw: string;
  readonly name: string;
  readonly args: string;
}

export interface CommandDispatchResult {
  readonly status: "handled" | "unknown" | "invalid" | "error";
  readonly command?: ChatCommand;
  readonly error?: string;
}

export type CommandHandler = (command: ParsedCommand) => void | Promise<void>;

export class CommandController {
  readonly #commands: readonly ChatCommand[];
  readonly #byName = new Map<string, ChatCommand>();
  readonly #handlers = new Map<string, CommandHandler>();

  constructor(commands: readonly ChatCommand[]) {
    this.#commands = [...commands];
    for (const command of commands) {
      this.#registerName(command.name, command);
      for (const alias of command.aliases) this.#registerName(alias, command);
    }
  }

  get commands(): readonly ChatCommand[] {
    return this.#commands;
  }

  register(name: string, handler: CommandHandler): this {
    const command = this.#byName.get(name);
    if (!command || command.name !== name) throw new Error(`Cannot register unknown or aliased command: ${name}`);
    if (this.#handlers.has(name)) throw new Error(`Command handler already registered: ${name}`);
    this.#handlers.set(name, handler);
    return this;
  }

  parse(raw: string): ParsedCommand | undefined {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/")) return undefined;
    const body = trimmed.replace(/^\/+\s*/u, "");
    if (!body) return undefined;
    const separator = body.search(/\s/u);
    return {
      raw,
      name: separator < 0 ? body : body.slice(0, separator),
      args: separator < 0 ? "" : body.slice(separator).trim(),
    };
  }

  resolve(name: string): ChatCommand | undefined {
    return this.#byName.get(name.trim().replace(/^\/+\s*/u, ""));
  }

  suggestions(prefix: string): readonly ChatCommand[] {
    const normalized = prefix.trim().replace(/^\/+\s*/u, "");
    if (!normalized) return this.#commands;
    return this.#commands.filter((command) => command.name.startsWith(normalized)
      || command.aliases.some((alias) => alias.startsWith(normalized)));
  }

  help(): string {
    return ["Commands:", ...this.#commands.map((command) => `${command.usage.padEnd(18)} ${command.description}`)].join("\n");
  }

  validate(): void {
    const missing = this.#commands.filter((command) => !this.#handlers.has(command.name));
    if (missing.length > 0) throw new Error(`Missing command handlers: ${missing.map((command) => command.name).join(", ")}`);
  }

  async dispatch(raw: string): Promise<CommandDispatchResult> {
    const parsed = this.parse(raw);
    if (!parsed) return { status: "invalid" };
    const command = this.resolve(parsed.name);
    if (!command) return { status: "unknown" };
    const handler = this.#handlers.get(command.name);
    if (!handler) return { status: "error", command, error: `Command is not available: /${command.name}` };
    try {
      await handler({ ...parsed, name: command.name });
      return { status: "handled", command };
    } catch (error) {
      return { status: "error", command, error: error instanceof Error ? error.message : String(error) };
    }
  }

  #registerName(name: string, command: ChatCommand): void {
    if (this.#byName.has(name)) throw new Error(`Duplicate command name or alias: ${name}`);
    this.#byName.set(name, command);
  }
}
