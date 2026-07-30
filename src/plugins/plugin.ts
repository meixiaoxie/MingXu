import type { Tool } from "../core/types.js";
import type { EventSink } from "../events/event-sink.js";

export type PluginKind = "tool" | "provider" | "memory" | "policy" | "audit" | "context" | "preset" | "skill" | "resource";

export type PresentationBlockKind = "markdown" | "diff" | "command" | "table" | "tree" | "keyvalue" | "progress";

export type PresentationBlockState = "streaming" | "complete" | "error" | "collapsed";

export interface PresentationBlock {
  readonly id: string;
  readonly kind: PresentationBlockKind;
  readonly revision?: number;
  readonly source?: string;
  readonly sensitivity?: "public" | "internal" | "secret";
  readonly state?: PresentationBlockState;
  readonly payload?: unknown;
}

export interface PluginPermissions {
  readonly files?: "none" | "read" | "write";
  readonly network?: "none" | "allow";
  readonly commands?: "none" | "allow";
  readonly env?: readonly string[];
}

export interface PluginManifestV1 {
  readonly apiVersion?: "mingxu/plugin-v1";
  readonly id?: string;
  readonly name: string;
  readonly version: string;
  readonly kind: PluginKind;
  readonly entry?: string;
  readonly description?: string;
  readonly configSchema?: unknown;
  readonly permissions?: PluginPermissions;
  readonly contributions?: readonly {
    readonly kind: PluginKind;
    readonly name: string;
  }[];
}

/**
 * Context passed once when a plugin is initialized.
 *
 * v0.1 intentionally keeps this surface small: plugins may only register tools.
 * The event sink exists for runtime integration, but it is not the main stable
 * compatibility promise for the plugin API.
 */
export interface PluginContext {
  registerTool(tool: Tool): void;
  unregisterTool?(name: string): boolean;
  eventSink?: EventSink;
}

export interface Plugin {
  readonly name: string;
  readonly manifest?: PluginManifestV1;
  kind?: PluginKind;
  riskLevel?: "low" | "high";
  policyRootDirectory?: string;
  setup(context: PluginContext): void | Promise<void>;
  activate?(context: PluginContext): void | Promise<void>;
  deactivate?(context: PluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
  healthCheck?(): boolean | Promise<boolean>;
}

export function definePlugin(plugin: Plugin): Plugin {
  if (!plugin.name.trim()) {
    throw new Error("Plugin name cannot be empty");
  }
  return plugin;
}
