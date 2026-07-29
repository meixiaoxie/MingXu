import { createHash } from "node:crypto";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { EventSink } from "../events/event-sink.js";
import { createRuntimeEvent } from "../events/runtime-events.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { Tool } from "../core/types.js";
import type { ResourceDescriptor, ResourceVisibility } from "../resources/resource-types.js";
import { ResourceRegistry } from "../resources/resource-registry.js";
import { assertSafeIdentifier } from "../safety/path-safety.js";

export type McpTransportKind = "stdio" | "streamable_http";

export interface McpToolPolicy {
  readonly riskLevel?: "low" | "high";
  readonly executionMode?: "sequential" | "parallel";
}

export interface McpServerConfig {
  readonly transport: McpTransportKind;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly tools?: Readonly<Record<string, McpToolPolicy>>;
  readonly visibility?: ResourceVisibility;
}

export interface McpClientManagerOptions {
  readonly toolRegistry: ToolRegistry;
  readonly resourceRegistry?: ResourceRegistry;
  readonly eventSink?: EventSink;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly principalId?: string;
  readonly maxConcurrentToolCalls?: number;
}

interface ConnectedServer {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly client: Client;
  readonly transport: StdioClientTransport | StreamableHTTPClientTransport;
}

export class McpClientManager {
  readonly #options: McpClientManagerOptions;
  readonly #servers = new Map<string, McpServerConfig>();
  readonly #connected = new Map<string, ConnectedServer>();
  readonly #resourceRegistry: ResourceRegistry;

  constructor(options: McpClientManagerOptions) {
    this.#options = options;
    this.#resourceRegistry = options.resourceRegistry ?? new ResourceRegistry();
  }

  registerServer(name: string, config: McpServerConfig): this {
    assertSafeIdentifier(name, "MCP server name");
    if (this.#servers.has(name)) {
      throw new Error(`MCP server already registered: ${name}`);
    }
    this.#servers.set(name, config);
    return this;
  }

  listServers(): string[] {
    return [...this.#servers.keys()];
  }

  listConnectedServers(): string[] {
    return [...this.#connected.keys()];
  }

  async connectAll(): Promise<void> {
    for (const [name, config] of this.#servers.entries()) {
      await this.connectServer(name, config);
    }
  }

  async connectServer(name: string, config?: McpServerConfig): Promise<void> {
    const resolvedConfig = config ?? this.#servers.get(name);
    if (!resolvedConfig) {
      throw new Error(`Unknown MCP server: ${name}`);
    }
    if (this.#connected.has(name)) {
      return;
    }

    await this.#emit("mcp.connect.start", { server: name, transport: resolvedConfig.transport });
    const client = new Client({ name: `mingxu-mcp-${name}`, version: "0.1.0" });
    const transport = this.#createTransport(resolvedConfig);

    try {
      await client.connect(transport as unknown as Transport);
      await this.#registerServerTools(name, resolvedConfig, client);
      await this.#registerServerResources(name, resolvedConfig, client);
      await this.#registerServerPrompts(name, resolvedConfig, client);
      this.#connected.set(name, { name, config: resolvedConfig, client, transport });
      await this.#emit("mcp.connect.end", { server: name, transport: resolvedConfig.transport });
    } catch (error) {
      await this.#safeClose(client);
      await this.#emit("mcp.connect.error", {
        server: name,
        transport: resolvedConfig.transport,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const server of this.#connected.values()) {
      await this.#safeClose(server.client);
    }
    this.#connected.clear();
  }

  getResourceRegistry(): ResourceRegistry {
    return this.#resourceRegistry;
  }

  #createTransport(config: McpServerConfig): StdioClientTransport | StreamableHTTPClientTransport {
    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error("stdio MCP server requires a command");
      }
      return new StdioClientTransport({
        command: config.command,
        ...(config.args !== undefined ? { args: [...config.args] } : {}),
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
        ...(config.env !== undefined ? { env: { ...config.env } } : {}),
      });
    }

    if (!config.url) {
      throw new Error("Streamable HTTP MCP server requires a url");
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
      ...(config.headers !== undefined ? { requestInit: { headers: { ...config.headers } } } : {}),
    });
  }

  async #registerServerTools(name: string, config: McpServerConfig, client: Client): Promise<void> {
    const result = await client.listTools();
    const seen = new Set<string>();
    for (const tool of result.tools) {
      if (!tool.name || !tool.name.trim()) {
        throw new Error(`MCP tool name is invalid on server ${name}`);
      }
      const stableName = stableMcpName(name, tool.name);
      if (seen.has(stableName)) {
        throw new Error(`Duplicate MCP tool name after normalization: ${stableName}`);
      }
      seen.add(stableName);
      const policy = config.tools?.[tool.name] ?? {};
      if (this.#options.toolRegistry.has(stableName)) {
        throw new Error(`MCP tool collides with existing tool: ${stableName}`);
      }
      const eventSink = this.#options.eventSink;
      const eventOptions = eventContext(this.#options);
      this.#options.toolRegistry.register({
        name: stableName,
        description: tool.description?.trim() || `MCP tool ${name}.${tool.name}`,
        inputSchema: tool.inputSchema,
        riskLevel: policy.riskLevel ?? "high",
        ...(policy.executionMode !== undefined ? { executionMode: policy.executionMode } : {}),
        async execute(input, context) {
          context?.signal?.throwIfAborted();
          await eventSink?.emit(createRuntimeEvent("mcp.tool.call.start", {
            server: name,
            tool: tool.name,
          }, eventOptions));
          try {
            const response = await client.callTool({ name: tool.name, arguments: normalizeMcpArguments(input) }, undefined, {
              ...(context?.signal !== undefined ? { signal: context.signal } : {}),
            });
            const output = normalizeMcpToolOutput(response);
            await eventSink?.emit(createRuntimeEvent("mcp.tool.call.end", {
              server: name,
              tool: tool.name,
            }, eventOptions));
            return output;
          } catch (error) {
            await eventSink?.emit(createRuntimeEvent("mcp.tool.call.error", {
              server: name,
              tool: tool.name,
              error: error instanceof Error ? error.message : String(error),
            }, eventOptions));
            throw error;
          }
        },
      } satisfies Tool);
      await this.#emit("mcp.tool.register", {
        server: name,
        tool: tool.name,
        stableName,
      });
    }
  }

  async #registerServerResources(name: string, config: McpServerConfig, client: Client): Promise<void> {
    const result = await client.listResources();
    for (const resource of result.resources) {
      if (!resource.uri || !resource.name) {
        throw new Error(`MCP resource is invalid on server ${name}`);
      }
      const stableName = stableMcpName(name, `resource:${resource.name}`);
      if (this.#resourceRegistry.has("mcp_resource", stableName)) {
        throw new Error(`MCP resource collides with existing resource: ${stableName}`);
      }
      this.#resourceRegistry.register({
        kind: "mcp_resource",
        name: stableName,
        visibility: config.visibility ?? "project",
        ...(resource.description !== undefined ? { description: resource.description.trim() } : {}),
        source: "mcp",
        metadata: {
          server: name,
          uri: resource.uri,
          mimeType: resource.mimeType,
          originalName: resource.name,
        },
        loader: async () => {
          await this.#emit("mcp.resource.read.start", { server: name, uri: resource.uri });
          try {
            const response = await client.readResource({ uri: resource.uri });
            const text = response.contents.map((item) => {
              if ("text" in item) return item.text;
              return item.blob;
            }).join("\n\n");
            await this.#emit("mcp.resource.read.end", { server: name, uri: resource.uri, bytes: Buffer.byteLength(text, "utf8") });
            return text;
          } catch (error) {
            await this.#emit("mcp.resource.read.error", {
              server: name,
              uri: resource.uri,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      });
      await this.#emit("mcp.resource.register", {
        server: name,
        uri: resource.uri,
        stableName,
      });
    }
  }

  async #registerServerPrompts(name: string, config: McpServerConfig, client: Client): Promise<void> {
    const result = await client.listPrompts();
    for (const prompt of result.prompts) {
      if (!prompt.name || !prompt.name.trim()) {
        throw new Error(`MCP prompt is invalid on server ${name}`);
      }
      const stableName = stableMcpName(name, `prompt:${prompt.name}`);
      if (this.#resourceRegistry.has("mcp_prompt", stableName)) {
        throw new Error(`MCP prompt collides with existing resource: ${stableName}`);
      }
      this.#resourceRegistry.register({
        kind: "mcp_prompt",
        name: stableName,
        visibility: config.visibility ?? "project",
        ...(prompt.description !== undefined ? { description: prompt.description.trim() } : {}),
        source: "mcp",
        metadata: (() => {
          const metadata: Record<string, unknown> = {
            server: name,
            originalName: prompt.name,
          };
          if (prompt.arguments !== undefined) {
            metadata.arguments = { value: prompt.arguments };
          }
          return metadata;
        })(),
        loader: async () => {
          await this.#emit("mcp.prompt.get.start", { server: name, prompt: prompt.name });
          try {
            const response = await client.getPrompt({ name: prompt.name });
            const text = response.messages.map((message) => {
              if (message.content.type === "text") return message.content.text;
              if (message.content.type === "resource") {
                const resource = message.content.resource as { text?: string; blob?: string };
                return resource.text ?? resource.blob ?? "";
              }
              return `[${message.content.type}]`;
            }).join("\n\n");
            await this.#emit("mcp.prompt.get.end", { server: name, prompt: prompt.name, bytes: Buffer.byteLength(text, "utf8") });
            return text;
          } catch (error) {
            await this.#emit("mcp.prompt.get.error", {
              server: name,
              prompt: prompt.name,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      });
      await this.#emit("mcp.prompt.register", {
        server: name,
        prompt: prompt.name,
        stableName,
      });
    }
  }

  async #emit(eventType: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.#options.eventSink || !this.#options.runId) return;
    await this.#options.eventSink.emit(createRuntimeEvent(eventType as never, payload as never, eventContext(this.#options)));
  }

  async #safeClose(client: Client): Promise<void> {
    try {
      await client.close();
    } catch {
      // ignore close errors during cleanup
    }
  }
}

function eventContext(options: Pick<McpClientManagerOptions, "runId" | "sessionId">): { runId: string; sequence: number; source: "core"; sessionId?: string } {
  return {
    runId: options.runId ?? "mcp-client",
    sequence: 1,
    source: "core",
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  };
}

function stableMcpName(server: string, name: string): string {
  const safeServer = sanitizeIdentifier(server);
  const safeName = sanitizeIdentifier(name);
  const hash = createHash("sha256").update(`${server}:${name}`).digest("hex").slice(0, 8);
  return `mcp_${safeServer}_${safeName}_${hash}`;
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return sanitized || "item";
}

function normalizeMcpToolOutput(response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  const result = response as { content?: unknown; structuredContent?: unknown; toolResult?: unknown; isError?: unknown };
  if (result.toolResult !== undefined) return result.toolResult;
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (result.content !== undefined) {
    return result.content;
  }
  return response;
}

function normalizeMcpArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}
