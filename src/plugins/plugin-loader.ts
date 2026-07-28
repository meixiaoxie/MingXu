import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import type { Plugin, PluginContext } from "./plugin.js";

type PluginModule = { default?: unknown; plugin?: unknown };

/** Loads local ESM plugins while rejecting malformed modules and duplicate names. */
export class PluginLoader {
  readonly #plugins = new Map<string, Plugin>();

  constructor(private readonly context: PluginContext) {}

  async load(pluginOrPath: Plugin | string): Promise<Plugin> {
    const plugin = typeof pluginOrPath === "string"
      ? await importPlugin(pluginOrPath)
      : pluginOrPath;

    if (this.#plugins.has(plugin.name)) {
      throw new Error(`Plugin already loaded: ${plugin.name}`);
    }

    await plugin.setup(this.context);
    this.#plugins.set(plugin.name, plugin);
    return plugin;
  }

  list(): readonly Plugin[] {
    return [...this.#plugins.values()];
  }
}

async function importPlugin(modulePath: string): Promise<Plugin> {
  if (!modulePath.trim()) {
    throw new Error("Plugin path cannot be empty");
  }

  const specifier = modulePath.startsWith("file:")
    ? modulePath
    : pathToFileURL(resolve(modulePath)).href;
  const imported = await import(specifier) as PluginModule;
  const candidate = imported.default ?? imported.plugin;

  if (!isPlugin(candidate)) {
    throw new Error(`Plugin module must export a plugin as default or "plugin": ${modulePath}`);
  }
  return candidate;
}

function isPlugin(value: unknown): value is Plugin {
  return typeof value === "object"
    && value !== null
    && typeof (value as Plugin).name === "string"
    && Boolean((value as Plugin).name.trim())
    && typeof (value as Plugin).setup === "function";
}
