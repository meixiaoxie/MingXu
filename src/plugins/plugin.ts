import type { Tool } from "../core/types.js";

/** Context passed once when a plugin is initialized. */
export interface PluginContext {
  registerTool(tool: Tool): void;
}

export interface Plugin {
  readonly name: string;
  setup(context: PluginContext): void | Promise<void>;
}

export function definePlugin(plugin: Plugin): Plugin {
  if (!plugin.name.trim()) {
    throw new Error("Plugin name cannot be empty");
  }
  return plugin;
}
