import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Plugin, PluginContext } from "./plugin.js";

type PluginModule = { default?: unknown; plugin?: unknown };

const SUPPORTED_PLUGIN_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

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
  const pluginPath = await validatePluginPath(modulePath);
  const imported = await import(pathToFileURL(pluginPath).href) as PluginModule;
  const candidate = imported.default ?? imported.plugin;

  if (!isPlugin(candidate)) {
    throw new Error(`Plugin module must export a plugin as default or "plugin": ${modulePath}`);
  }
  return candidate;
}

/** Accepts filesystem paths and local file URLs, but never package or network specifiers. */
async function validatePluginPath(modulePath: string): Promise<string> {
  const trimmedPath = modulePath.trim();
  if (!trimmedPath) {
    throw new Error("Plugin path cannot be empty");
  }
  if (trimmedPath.includes("\0")) {
    throw new Error("Plugin path cannot contain null bytes");
  }

  let pluginPath: string;
  if (trimmedPath.startsWith("file:")) {
    pluginPath = parseLocalFileUrl(trimmedPath);
  } else {
    // A colon before any slash indicates a URL scheme. The Windows drive-letter
    // form is exempt so absolute local paths continue to work on Windows.
    if (hasUnsupportedScheme(trimmedPath)) {
      throw new Error("Plugin path must be a local filesystem path or file URL");
    }
    if (isNetworkPath(trimmedPath)) {
      throw new Error("Plugin path must reference a local file, not a network share");
    }
    pluginPath = resolve(trimmedPath);
  }

  if (!hasSupportedPluginExtension(pluginPath)) {
    throw new Error("Plugin path must reference a JavaScript module (.js, .mjs, or .cjs)");
  }

  let pluginStats;
  try {
    pluginStats = await stat(pluginPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Plugin file does not exist: ${modulePath}`, { cause: error });
    }
    throw error;
  }
  if (!pluginStats.isFile()) {
    throw new Error(`Plugin path must reference a file: ${modulePath}`);
  }

  return pluginPath;
}

function parseLocalFileUrl(modulePath: string): string {
  let url: URL;
  try {
    url = new URL(modulePath);
  } catch (error) {
    throw new Error(`Invalid plugin file URL: ${modulePath}`, { cause: error });
  }

  // Credentials, remote hosts, query strings, and fragments have no useful
  // meaning for a local plugin and can hide a misleading import target.
  if (url.protocol !== "file:"
    || (url.hostname !== "" && url.hostname !== "localhost")
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== "") {
    throw new Error("Plugin file URL must be local and cannot contain extra URL data");
  }

  try {
    return fileURLToPath(url);
  } catch (error) {
    throw new Error(`Plugin file URL must reference a local file: ${modulePath}`, { cause: error });
  }
}

function hasUnsupportedScheme(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/u.test(value) && isAbsolute(value)) return false;
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(value);
}

function isNetworkPath(value: string): boolean {
  return value.startsWith("\\\\") || value.startsWith("//");
}

function hasSupportedPluginExtension(value: string): boolean {
  const extension = /\.[^.\\/]+$/u.exec(value)?.[0].toLowerCase();
  return extension !== undefined && SUPPORTED_PLUGIN_EXTENSIONS.has(extension);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isPlugin(value: unknown): value is Plugin {
  return typeof value === "object"
    && value !== null
    && typeof (value as Plugin).name === "string"
    && Boolean((value as Plugin).name.trim())
    && typeof (value as Plugin).setup === "function";
}
