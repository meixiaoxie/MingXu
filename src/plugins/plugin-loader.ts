import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createRuntimeEvent } from "../events/runtime-events.js";
import type { Tool } from "../core/types.js";
import { definePluginManifest } from "./plugin.js";
import type { Plugin, PluginContext, PluginManifestV1, PluginKind } from "./plugin.js";

const SUPPORTED_PLUGIN_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

export interface PluginLoadRequest {
  readonly path: string;
  readonly configFilePath?: string;
  readonly trust?: "trusted_local" | "blocked";
  readonly kind?: PluginKind;
  readonly manifest?: string;
}

export interface ResolvedPluginSource {
  readonly declaredPath: string;
  readonly resolvedPath: string;
  readonly trust: "trusted_local" | "blocked";
  readonly sourceKind: "local_path" | "file_url" | "directory" | "archive";
  readonly kind?: PluginKind;
  readonly manifest?: string;
}

interface PluginMetadata {
  kind?: PluginKind;
  manifest?: PluginManifestV1;
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
  let sourceKind: ResolvedPluginSource["sourceKind"] = "local_path";
  if (trimmedPath.startsWith("file:")) {
    resolvedPath = parseLocalFileUrl(trimmedPath);
    sourceKind = "file_url";
  } else {
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

  let pluginStats;
  try {
    pluginStats = await stat(resolvedPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Plugin file does not exist: ${request.path}`, { cause: error });
    }
    throw error;
  }
  if (pluginStats.isDirectory()) {
    sourceKind = "directory";
  } else if (pluginStats.isFile()) {
    if (looksLikeArchive(resolvedPath)) {
      sourceKind = "archive";
    } else if (!hasSupportedPluginExtension(resolvedPath)) {
      throw new Error("Plugin path must reference a JavaScript module, a package directory, or a tarball");
    }
  } else {
    throw new Error(`Plugin path must reference a file or directory: ${request.path}`);
  }

  return {
    declaredPath: request.path,
    resolvedPath,
    trust,
    sourceKind,
    ...(request.kind !== undefined ? { kind: request.kind } : {}),
    ...(request.manifest !== undefined ? { manifest: request.manifest } : {}),
  };
}

async function importPlugin(request: PluginLoadRequest): Promise<Plugin> {
  const pluginSource = await resolvePluginLoadRequest(request);
  const entryPath = await resolvePluginEntryPath(pluginSource);
  const imported = await import(pathToFileURL(entryPath).href) as { default?: unknown; plugin?: unknown };
  const candidate = imported.default ?? imported.plugin;

  if (!isPlugin(candidate)) {
    throw new Error(`Plugin module must export a plugin as default or "plugin": ${request.path}`);
  }

  const pluginMetadata = extractPluginMetadata(candidate);
  validatePluginMetadata(pluginSource, pluginMetadata);

  return candidate;
}

async function resolvePluginEntryPath(source: ResolvedPluginSource): Promise<string> {
  const resolvedStats = await stat(source.resolvedPath);
  if (resolvedStats.isFile()) {
    return source.resolvedPath;
  }
  if (resolvedStats.isDirectory()) {
    const manifestPath = resolve(source.resolvedPath, "mingxu.plugin.json");
    const manifest = parsePluginManifest(await readFile(manifestPath, "utf8"));
    const entryPath = resolve(source.resolvedPath, manifest.entry ?? "index.js");
    await stat(entryPath);
    return entryPath;
  }
  throw new Error(`Plugin path must reference a file or directory: ${source.declaredPath}`);
}

function extractPluginMetadata(plugin: Plugin): PluginMetadata {
  return {
    ...(plugin.kind !== undefined ? { kind: plugin.kind } : {}),
    ...(plugin.manifest !== undefined ? { manifest: plugin.manifest } : {}),
  };
}

function validatePluginMetadata(source: ResolvedPluginSource, metadata: PluginMetadata): void {
  const declaredKind = metadata.kind ?? metadata.manifest?.kind;
  if (source.kind !== undefined && declaredKind !== undefined && source.kind !== declaredKind) {
    throw new Error(`Plugin kind mismatch: requested ${source.kind}, module declared ${declaredKind}`);
  }

  if (source.manifest !== undefined) {
    const declaredName = metadata.manifest?.name;
    if (declaredName === undefined) {
      throw new Error(`Plugin manifest mismatch: expected ${source.manifest}, got none`);
    }
    if (declaredName !== source.manifest) {
      throw new Error(`Plugin manifest mismatch: expected ${source.manifest}, got ${declaredName}`);
    }
  }
}

function parseLocalFileUrl(modulePath: string): string {
  let url: URL;
  try {
    url = new URL(modulePath);
  } catch (error) {
    throw new Error(`Invalid plugin file URL: ${modulePath}`, { cause: error });
  }

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

function looksLikeArchive(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.endsWith(".tgz") || lower.endsWith(".tar.gz") || lower.endsWith(".tar");
}

function parsePluginManifest(source: string): PluginManifestV1 {
  const parsed = JSON.parse(source) as Partial<PluginManifestV1>;
  if (parsed.apiVersion !== "mingxu/plugin-v1") {
    throw new Error("Extension manifest apiVersion must be mingxu/plugin-v1");
  }
  if (typeof parsed.id !== "string" || !parsed.id.trim()) {
    throw new Error("Extension manifest id is required");
  }
  if (typeof parsed.name !== "string" || !parsed.name.trim()) {
    throw new Error("Extension manifest name is required");
  }
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error("Extension manifest version is required");
  }
  if (parsed.kind === undefined) {
    throw new Error("Extension manifest kind is required");
  }
  return definePluginManifest({
    apiVersion: "mingxu/plugin-v1",
    id: parsed.id.trim(),
    name: parsed.name.trim(),
    version: parsed.version.trim(),
    kind: parsed.kind,
    ...(parsed.entry !== undefined ? { entry: parsed.entry } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.configSchema !== undefined ? { configSchema: parsed.configSchema } : {}),
    ...(parsed.permissions !== undefined ? { permissions: parsed.permissions } : {}),
    contributions: Array.isArray(parsed.contributions) ? parsed.contributions : [],
  });
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
