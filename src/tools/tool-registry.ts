import type { Tool } from "../core/types.js";

export interface ToolExecutionRequest {
  readonly name: string;
  readonly input?: unknown;
  readonly arguments?: unknown;
}

/** Stores tools by name and provides the single execution entry used by the agent loop. */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: Iterable<Tool> = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: Tool): this {
    const name = tool.name.trim();
    if (!name) {
      throw new Error("Tool name cannot be empty");
    }
    if (name !== tool.name) {
      throw new Error(`Tool name cannot have surrounding whitespace: ${tool.name}`);
    }
    if (this.#tools.has(name)) {
      throw new Error(`Tool already registered: ${name}`);
    }
    this.#tools.set(name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  list(): readonly Tool[] {
    return [...this.#tools.values()];
  }

  /** Accepts either separate arguments or a tool-call-shaped object for easy integration. */
  async execute(name: string, input?: unknown): Promise<unknown>;
  async execute(request: ToolExecutionRequest): Promise<unknown>;
  async execute(
    nameOrRequest: string | ToolExecutionRequest,
    input?: unknown,
  ): Promise<unknown> {
    const name = typeof nameOrRequest === "string" ? nameOrRequest : nameOrRequest.name;
    const resolvedInput = typeof nameOrRequest === "string"
      ? input
      : resolveRequestInput(nameOrRequest);
    const tool = this.#tools.get(name);

    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.execute(resolvedInput);
  }
}

/** Preserve an explicitly supplied input value, including null, false, and zero. */
function resolveRequestInput(request: ToolExecutionRequest): unknown {
  if (Object.prototype.hasOwnProperty.call(request, "input")) {
    return request.input;
  }
  return request.arguments;
}
