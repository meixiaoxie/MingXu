import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  defineExtensionAdapter,
  definePluginManifest,
} from "../plugins/plugin.js";
import type {
  ExtensionAdapterV1,
  ExtensionDescriptor,
  ExtensionInspectResult,
  ExtensionSource,
  PluginManifestV1,
  PluginModuleV1,
} from "../plugins/plugin.js";

import { assertPathInsideRoot, assertSafeLocalPath } from "../safety/path-safety.js";

const MANIFEST_FILE_NAME = "mingxu.plugin.json";
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export interface ExtensionAdapterRegistry {
  register(adapter: ExtensionAdapterV1): void;
  list(): readonly ExtensionAdapterV1[];
  probe(packageRoot: string): Promise<ExtensionAdapterV1>;
  inspect(packageRoot: string, source: ExtensionSource): Promise<ExtensionInspectResult>;
  load(packageRoot: string, source: ExtensionSource): Promise<PluginModuleV1>;
}

export function createDefaultExtensionAdapterRegistry(): ExtensionAdapterRegistry {
  return new DefaultExtensionAdapterRegistry([createMingxuNativeExtensionAdapter()]);
}

export function createMingxuNativeExtensionAdapter(): ExtensionAdapterV1 {
  return defineExtensionAdapter({
    adapterId: "mingxu-native",
    async probe(packageRoot: string): Promise<number | false> {
      try {
        const manifest = await readManifest(packageRoot);
        return manifest.apiVersion === "mingxu/plugin-v1" ? 100 : false;
      } catch {
        return false;
      }
    },
    async inspect(packageRoot: string, source: ExtensionSource): Promise<ExtensionInspectResult> {
      const manifest = await readManifest(packageRoot);
      const manifestPath = resolve(packageRoot, MANIFEST_FILE_NAME);
      const entryPath = await resolveEntryPath(packageRoot, manifest);
      const manifestHash = sha256Hex(stableStringify(manifest));
      const sha256 = await hashDirectory(packageRoot);
      const capabilities = manifest.contributions.map((contribution: PluginManifestV1["contributions"][number]) => contribution.name);
      return {
        adapterId: "mingxu-native",
        manifest,
        packageRoot,
        manifestPath,
        entryPath,
        manifestHash,
        sha256,
        source,
        upstreamId: manifest.id,
        upstreamVersion: manifest.version,
        upstreamManifestHash: manifestHash,
        capabilities,
        unsupportedCapabilities: [],
      };
    },
    async load(packageRoot: string, source: ExtensionSource): Promise<PluginModuleV1> {
      const inspection = await this.inspect(packageRoot, source);
      const imported = await import(pathToFileURL(inspection.entryPath).href) as {
        default?: unknown;
        plugin?: unknown;
      };
      const candidate = imported.default ?? imported.plugin;
      if (!isPluginModule(candidate)) {
        throw new Error(`Extension module must export a plugin as default or "plugin": ${inspection.entryPath}`);
      }
      const plugin = candidate as PluginModuleV1;
      if (plugin.manifest === undefined) {
        throw new Error(`Extension module must expose a manifest: ${inspection.entryPath}`);
      }
      definePluginManifest(plugin.manifest);
      if (plugin.manifest.id !== inspection.manifest.id) {
        throw new Error(`Extension manifest mismatch: expected ${inspection.manifest.id}, got ${plugin.manifest.id}`);
      }
      if (plugin.manifest.version !== inspection.manifest.version) {
        throw new Error(`Extension manifest mismatch: expected version ${inspection.manifest.version}, got ${plugin.manifest.version}`);
      }
      return plugin;
    },
  });
}

class DefaultExtensionAdapterRegistry implements ExtensionAdapterRegistry {
  readonly #adapters: ExtensionAdapterV1[];

  constructor(adapters: readonly ExtensionAdapterV1[]) {
    this.#adapters = [...adapters];
  }

  register(adapter: ExtensionAdapterV1): void {
    this.#adapters.push(adapter);
  }

  list(): readonly ExtensionAdapterV1[] {
    return [...this.#adapters];
  }

  async probe(packageRoot: string): Promise<ExtensionAdapterV1> {
    const matches: Array<{ adapter: ExtensionAdapterV1; priority: number }> = [];
    for (const adapter of this.#adapters) {
      const priority = await adapter.probe(packageRoot);
      if (priority === false) continue;
      matches.push({ adapter, priority });
    }
    if (matches.length === 0) {
      throw new Error(`No supported extension adapter matched: ${packageRoot}`);
    }
    matches.sort((left, right) => right.priority - left.priority);
    if (matches.length > 1 && matches[0]!.priority === matches[1]!.priority) {
      const conflictIds = matches.filter((entry) => entry.priority === matches[0]!.priority).map((entry) => entry.adapter.adapterId).join(", ");
      throw new Error(`Multiple extension adapters matched ${packageRoot}: ${conflictIds}`);
    }
    return matches[0]!.adapter;
  }

  async inspect(packageRoot: string, source: ExtensionSource): Promise<ExtensionInspectResult> {
    const adapter = await this.probe(packageRoot);
    return await adapter.inspect(packageRoot, source);
  }

  async load(packageRoot: string, source: ExtensionSource): Promise<PluginModuleV1> {
    const adapter = await this.probe(packageRoot);
    return await adapter.load(packageRoot, source);
  }
}

async function readManifest(packageRoot: string): Promise<PluginManifestV1> {
  const resolvedRoot = assertSafeLocalPath(packageRoot, "Extension package root");
  const manifestPath = resolve(resolvedRoot, MANIFEST_FILE_NAME);
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<PluginManifestV1>;
  const manifest = definePluginManifest({
    apiVersion: parsed.apiVersion ?? "mingxu/plugin-v1",
    id: String(parsed.id ?? "").trim(),
    name: String(parsed.name ?? "").trim(),
    version: String(parsed.version ?? "").trim(),
    kind: (parsed.kind ?? "tool") as PluginManifestV1["kind"],
    ...(parsed.entry !== undefined ? { entry: parsed.entry } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.configSchema !== undefined ? { configSchema: parsed.configSchema } : {}),
    ...(parsed.permissions !== undefined ? { permissions: parsed.permissions } : {}),
    contributions: Array.isArray(parsed.contributions) ? parsed.contributions : [],
    ...(parsed.adapterId !== undefined ? { adapterId: parsed.adapterId } : {}),
  });
  return manifest;
}

async function resolveEntryPath(packageRoot: string, manifest: PluginManifestV1): Promise<string> {
  const entryPath = resolve(packageRoot, manifest.entry ?? "index.js");
  await assertPathInsideRoot(packageRoot, entryPath, "Extension entry");
  await stat(entryPath);
  return entryPath;
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = await walkTree(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of entries) {
    hash.update(relative(root, entry.path));
    const content = await readFile(entry.path);
    hash.update(content);
  }
  return hash.digest("hex");
}

async function walkTree(root: string): Promise<Array<{ path: string; size: number; isSymbolicLink: boolean }>> {
  const entries: Array<{ path: string; size: number; isSymbolicLink: boolean }> = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const listing = await readdir(current, { withFileTypes: true });
    for (const entry of listing) {
      const entryPath = resolve(current, entry.name);
      const stats = await lstat(entryPath);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        entries.push({
          path: entryPath,
          size: stats.size,
          isSymbolicLink: stats.isSymbolicLink(),
        });
      }
    }
  }
  if (entries.length > MAX_FILES) {
    throw new Error(`Extension package exceeds file count limit: ${entries.length}`);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    const relativePath = relative(root, entry.path);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Extension package contains an unsafe path: ${entry.path}`);
    }
    if (entry.isSymbolicLink) {
      throw new Error(`Extension package cannot contain symbolic links: ${relativePath}`);
    }
    if (entry.size > MAX_FILE_BYTES) {
      throw new Error(`Extension package file exceeds size limit: ${relativePath}`);
    }
    totalBytes += entry.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Extension package exceeds total size limit: ${root}`);
    }
  }
  return entries;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function isPluginModule(value: unknown): value is PluginModuleV1 {
  return typeof value === "object"
    && value !== null
    && typeof (value as PluginModuleV1).name === "string"
    && Boolean((value as PluginModuleV1).name.trim())
    && typeof (value as PluginModuleV1).setup === "function";
}
