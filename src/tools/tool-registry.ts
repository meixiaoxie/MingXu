import type { RunContext, Tool, ToolExecutionContext } from "../core/types.js";

export interface ToolExecutionRequest {
  readonly name: string;
  readonly input?: unknown;
  readonly arguments?: unknown;
  readonly context?: RunContext;
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
      throw new Error(
        `Tool name cannot have surrounding whitespace: ${tool.name}`,
      );
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

  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  list(): readonly Tool[] {
    return [...this.#tools.values()];
  }

  /** Accepts either separate arguments or a tool-call-shaped object for easy integration. */
  async execute(
    name: string,
    input?: unknown,
    context?: ToolExecutionContext,
  ): Promise<unknown>;
  async execute(
    request: ToolExecutionRequest,
    context?: ToolExecutionContext,
  ): Promise<unknown>;
  async execute(
    nameOrRequest: string | ToolExecutionRequest,
    inputOrContext?: unknown | ToolExecutionContext,
    maybeContext?: ToolExecutionContext,
  ): Promise<unknown> {
    const isStringCall = typeof nameOrRequest === "string";
    const name = isStringCall ? nameOrRequest : nameOrRequest.name;
    const resolvedInput = isStringCall
      ? inputOrContext
      : resolveRequestInput(nameOrRequest);
    // 从 request 对象里取 context（旧接口），或者从第二个/第三个参数取（新接口）
    const context = isStringCall
      ? (maybeContext as RunContext | undefined)
      : (nameOrRequest as ToolExecutionRequest).context;

    const tool = this.#tools.get(name);

    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.execute(resolvedInput, context);
  }
}

/** Preserve an explicitly supplied input value, including null, false, and zero. */
function resolveRequestInput(request: ToolExecutionRequest): unknown {
  if (Object.prototype.hasOwnProperty.call(request, "input")) {
    return request.input;
  }
  return request.arguments;
}
