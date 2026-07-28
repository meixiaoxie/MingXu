import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createRuntimeEvent } from "../events/runtime-events.js";
import type { Tool } from "../core/types.js";
import type { Plugin, PluginContext } from "./plugin.js";

type PluginModule = { default?: unknown; plugin?: unknown };

const SUPPORTED_PLUGIN_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

export interface PluginLoadRequest {
  readonly path: string;
  readonly configFilePath?: string;
  readonly trust?: "trusted_local" | "blocked";
}

export interface ResolvedPluginSource {
  readonly declaredPath: string;
  readonly resolvedPath: string;
  readonly trust: "trusted_local" | "blocked";
  readonly sourceKind: "local_path" | "file_url";
}

/** Loads local ESM plugins while rejecting malformed modules and duplicate names. */
export class PluginLoader {
  readonly #plugins = new Map<string, Plugin>();
  #sequence = 0;

  constructor(private readonly context: PluginContext) {}

  async load(pluginOrRequest: Plugin | string | PluginLoadRequest): Promise<Plugin> {
    const runId = "plugin-loader";
    const sourcePath = typeof pluginOrRequest === "string"
      ? pluginOrRequest
      : isPluginLoadRequest(pluginOrRequest)
        ? pluginOrRequest.path
        : pluginOrRequest.name;
    await this.context.eventSink?.emit(createRuntimeEvent("plugin.load.start", {
      pluginPath: sourcePath,
    }, {
      runId,
      sequence: ++this.#sequence,
      source: "plugin",
    }));

    try {
      const plugin = typeof pluginOrRequest === "string" || isPluginLoadRequest(pluginOrRequest)
        ? await importPlugin(typeof pluginOrRequest === "string"
          ? { path: pluginOrRequest }
          : pluginOrRequest)
        : pluginOrRequest;

      if (this.#plugins.has(plugin.name)) {
        throw new Error(`Plugin already loaded: ${plugin.name}`);
      }

      const registeredToolNames: string[] = [];
      const transactionalContext: PluginContext = {
        ...this.context,
        registerTool: (tool: Tool) => {
          this.context.registerTool(tool);
          registeredToolNames.push(tool.name);
        },
      };

      try {
        await plugin.setup(transactionalContext);
      } catch (error) {
        for (const toolName of registeredToolNames.reverse()) {
          this.context.unregisterTool?.(toolName);
        }
        throw error;
      }

      this.#plugins.set(plugin.name, plugin);
      await this.context.eventSink?.emit(createRuntimeEvent("plugin.load.end", {
        pluginName: plugin.name,
        pluginPath: sourcePath,
      }, {
        runId,
        sequence: ++this.#sequence,
        source: "plugin",
      }));
      return plugin;
    } catch (error) {
      await this.context.eventSink?.emit(createRuntimeEvent("plugin.load.error", {
        pluginPath: sourcePath,
        error: error instanceof Error ? error.message : String(error),
      }, {
        runId,
        sequence: ++this.#sequence,
        source: "plugin",
      }));
      throw error;
    }
  }

  list(): readonly Plugin[] {
    return [...this.#plugins.values()];
  }
}

export async function resolvePluginLoadRequest(request: PluginLoadRequest): Promise<ResolvedPluginSource> {
  const trimmedPath = request.path.trim();
  if (!trimmedPath) {
    throw new Error("Plugin path cannot be empty");
  }
  if (trimmedPath.includes("\0")) {
    throw new Error("Plugin path cannot contain null bytes");
  }

  const trust = request.trust ?? "trusted_local";
  if (trust === "blocked") {
    throw new Error(`Plugin is blocked by configuration: ${trimmedPath}`);
  }

  let resolvedPath: string;
  let sourceKind: "local_path" | "file_url" = "local_path";
  if (trimmedPath.startsWith("file:")) {
    resolvedPath = parseLocalFileUrl(trimmedPath);
    sourceKind = "file_url";
  } else {
    // A colon before any slash indicates a URL scheme. The Windows drive-letter
    // form is exempt so absolute local paths continue to work on Windows.
    if (hasUnsupportedScheme(trimmedPath)) {
      throw new Error("Plugin path must be a local filesystem path or file URL");
    }
    if (isNetworkPath(trimmedPath)) {
      throw new Error("Plugin path must reference a local file, not a network share");
    }
    const configBaseDirectory = request.configFilePath !== undefined
      ? dirname(resolve(request.configFilePath))
      : process.cwd();
    resolvedPath = isAbsolute(trimmedPath)
      ? resolve(trimmedPath)
      : resolve(configBaseDirectory, trimmedPath);
  }

  if (!hasSupportedPluginExtension(resolvedPath)) {
    throw new Error("Plugin path must reference a JavaScript module (.js, .mjs, or .cjs)");
  }

  let pluginStats;
  try {
    pluginStats = await stat(resolvedPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Plugin file does not exist: ${request.path}`, { cause: error });
    }
    throw error;
  }
  if (!pluginStats.isFile()) {
    throw new Error(`Plugin path must reference a file: ${request.path}`);
  }

  return {
    declaredPath: request.path,
    resolvedPath,
    trust,
    sourceKind,
  };
}

async function importPlugin(request: PluginLoadRequest): Promise<Plugin> {
  const pluginSource = await resolvePluginLoadRequest(request);
  const imported = await import(pathToFileURL(pluginSource.resolvedPath).href) as PluginModule;
  const candidate = imported.default ?? imported.plugin;

  if (!isPlugin(candidate)) {
    throw new Error(`Plugin module must export a plugin as default or "plugin": ${request.path}`);
  }
  return candidate;
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

function isPluginLoadRequest(value: unknown): value is PluginLoadRequest {
  return typeof value === "object"
    && value !== null
    && "path" in value
    && typeof (value as PluginLoadRequest).path === "string";
}
