import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { realpath } from "node:fs/promises";

import { resolveAgentConfig, type AgentConfigInput, type ResolvedAgentConfig } from "../config/config-schema.js";
import { assertSafeLocalPath } from "../safety/path-safety.js";

export interface ConfigDiscoveryOptions {
  readonly explicitConfigPath?: string;
  readonly noGlobalConfig?: boolean;
  readonly trustProject?: boolean;
  readonly noTrustProject?: boolean;
  readonly cwd?: string;
}

export interface ConfigLayerInfo {
  readonly kind: "explicit" | "global" | "project";
  readonly path: string;
}

export interface CliConfigDiscoveryResult {
  readonly config: ResolvedAgentConfig;
  readonly sources: readonly ConfigLayerInfo[];
  readonly projectPath?: string;
  readonly projectTrusted: boolean;
}

export async function discoverCliConfig(
  options: ConfigDiscoveryOptions = {},
): Promise<CliConfigDiscoveryResult | undefined> {
  const cwd = resolve(options.cwd ?? process.cwd());

  if (options.explicitConfigPath) {
    const layer = await readConfigLayer(resolve(cwd, options.explicitConfigPath));
    return {
      config: resolveAgentConfig(layer),
      sources: [{ kind: "explicit", path: layer.__sourcePath }],
      projectTrusted: true,
    };
  }

  const layers: Array<{ kind: ConfigLayerInfo["kind"]; path: string; config: Partial<AgentConfigInput> & Record<string, unknown> & { __sourcePath: string } }> = [];
  let projectPath: string | undefined;
  let projectTrusted = false;

  if (!options.noGlobalConfig) {
    const globalPath = getGlobalConfigPath();
    if (await exists(globalPath)) {
      const layer = await readConfigLayer(globalPath);
      layers.push({ kind: "global", path: layer.__sourcePath, config: layer });
    }
  }

  projectPath = await findProjectConfig(cwd);
  if (projectPath && options.trustProject) {
    await setProjectTrust(dirname(projectPath), true);
  }

  if (projectPath && !options.noTrustProject && await shouldLoadProjectConfig(projectPath)) {
    const layer = await readConfigLayer(projectPath);
    layers.push({ kind: "project", path: layer.__sourcePath, config: layer });
    projectTrusted = true;
  }

  if (layers.length === 0) {
    return undefined;
  }

  const merged = layers.reduce((acc, layer) => deepMergeConfig(acc, stripSource(layer.config)), {} as Record<string, unknown>);
  return {
    config: resolveAgentConfig(merged as AgentConfigInput),
    sources: layers.map(({ kind, path }) => ({ kind, path })),
    ...(projectPath !== undefined ? { projectPath } : {}),
    projectTrusted,
  };
}

export async function readConfigLayer(filePath: string): Promise<Partial<AgentConfigInput> & { readonly __sourcePath: string }> {
  const resolvedPath = resolve(filePath);
  let source: string;
  try {
    source = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read config file: ${resolvedPath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Config file is not valid JSON: ${resolvedPath}`, { cause: error });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${resolvedPath}`);
  }

  const normalized = resolveConfigLayerPaths(parsed as Record<string, unknown>, dirname(resolvedPath));
  return { ...normalized, __sourcePath: resolvedPath };
}

export function getGlobalConfigPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? process.cwd();
    return resolve(appData, "mingxu", "config.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? resolve(process.env.HOME ?? process.cwd(), ".config");
  return resolve(xdg, "mingxu", "config.json");
}

export async function getProjectConfigPath(startDir = process.cwd()): Promise<string | undefined> {
  return findProjectConfig(startDir);
}

export function getUserConfigDir(): string {
  if (process.platform === "win32") {
    return resolve(process.env.APPDATA ?? process.cwd(), "mingxu");
  }
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(process.env.HOME ?? process.cwd(), ".config"), "mingxu");
}

export function getTrustStorePath(): string {
  return resolve(getUserConfigDir(), "trusted-projects.json");
}

export async function setProjectTrust(projectPath: string, trusted: boolean): Promise<void> {
  const storePath = getTrustStorePath();
  await mkdir(dirname(storePath), { recursive: true });
  const current = await loadTrustStore();
  const canonical = await canonicalizePath(projectPath);
  current.projects[canonical] = {
    trusted,
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(storePath, current);
}

export async function isProjectTrusted(projectPath: string): Promise<boolean> {
  const canonical = await canonicalizePath(projectPath);
  const current = await loadTrustStore();
  return current.projects[canonical]?.trusted === true;
}

async function loadTrustStore(): Promise<{ projects: Record<string, { trusted: boolean; updatedAt: string }> }> {
  const storePath = getTrustStorePath();
  try {
    const text = await readFile(storePath, "utf8");
    const parsed = JSON.parse(text) as { projects?: Record<string, { trusted?: boolean; updatedAt?: string }> };
    const projects: Record<string, { trusted: boolean; updatedAt: string }> = {};
    for (const [key, value] of Object.entries(parsed.projects ?? {})) {
      projects[key] = {
        trusted: value.trusted === true,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
      };
    }
    return { projects };
  } catch {
    return { projects: {} };
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function canonicalizePath(input: string): Promise<string> {
  const resolved = resolve(input);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findProjectConfig(startDir: string): Promise<string | undefined> {
  let current = resolve(startDir);
  while (true) {
    const candidate = resolve(current, "mingxu.config.json");
    if (await exists(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function shouldLoadProjectConfig(projectConfigPath: string): Promise<boolean> {
  const projectRoot = dirname(projectConfigPath);
  return isProjectTrusted(projectRoot);
}

function stripSource(layer: Partial<AgentConfigInput> & { __sourcePath: string }): Partial<AgentConfigInput> {
  const { __sourcePath: _sourcePath, ...rest } = layer;
  return rest;
}

function deepMergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = merged[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      merged[key] = dedupeArray([...existing, ...value]);
      continue;
    }
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = deepMergeConfig(existing, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function dedupeArray(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveConfigLayerPaths(input: Record<string, unknown>, baseDir: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = resolveConfigValue(key, value, baseDir);
  }
  return output;
}

function resolveConfigValue(key: string, value: unknown, baseDir: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    if (key === "files" || key === "dirs") {
      return value.map((item) => typeof item === "string" ? resolvePathLike(baseDir, item) : item);
    }
    if (key === "plugins") {
      return value.map((item) => typeof item === "string"
        ? resolvePathLike(baseDir, item)
        : isPlainObject(item)
          ? resolvePluginEntry(item, baseDir)
          : item);
    }
    return value.map((item) => resolveConfigValue(key, item, baseDir));
  }

  if (!isPlainObject(value)) {
    if (typeof value === "string" && (
      key === "dir"
      || key === "file"
      || key === "path"
      || key === "module"
      || key === "cwd"
      || key === "rootDirectory"
      || key === "customProviderModule"
      || key === "sessionFile"
    )) {
      return resolvePathLike(baseDir, value);
    }
    return value;
  }

  if (key === "instructions" || key === "memory" || key === "resources" || key === "skills" || key === "session" || key === "audit" || key === "secrets" || key === "runtime" || key === "redaction") {
    const nested: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      nested[nestedKey] = resolveConfigValue(nestedKey, nestedValue, baseDir);
    }
    return nested;
  }

  if (key === "mcpServers" || key === "models" || key === "providers" || key === "customProviders" || key === "presets") {
    const nested: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      nested[nestedKey] = resolveConfigValue(key, nestedValue, baseDir);
    }
    return nested;
  }

  const nested: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    nested[nestedKey] = resolveConfigValue(nestedKey, nestedValue, baseDir);
  }
  return nested;
}

function resolvePluginEntry(value: Record<string, unknown>, baseDir: string): Record<string, unknown> {
  const output: Record<string, unknown> = { ...value };
  if (typeof output.path === "string") {
    output.path = resolvePathLike(baseDir, output.path);
  }
  return output;
}

function resolvePathLike(baseDir: string, value: string): string {
  const candidate = isAbsolute(value) ? value : resolve(baseDir, value);
  return assertSafeLocalPath(candidate, "Config path");
}
