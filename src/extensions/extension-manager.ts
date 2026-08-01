import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, stat, lstat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { assertSafeIdentifier, assertSafeLocalPath } from "../safety/path-safety.js";
import type { PluginLoader } from "../plugins/plugin-loader.js";
import type {
  ExtensionAdapterV1,
  ExtensionDescriptor,
  ExtensionInspectResult,
  ExtensionLockFile,
  ExtensionLockRecord,
  ExtensionManifestV1,
  ExtensionSource,
  PluginModuleV1,
} from "@mingxu/plugin-sdk";
import { createDefaultExtensionAdapterRegistry, type ExtensionAdapterRegistry } from "./adapter-registry.js";

const execFileAsync = promisify(execFile);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const LOCK_FILE_NAME = "extensions.lock.json";
const MANIFEST_FILE_NAME = "mingxu.plugin.json";
const SUPPORTED_ARCHIVE_EXTENSIONS = new Set([".tgz", ".tar.gz", ".tar"]);

export interface ExtensionManagerOptions {
  readonly userRoot: string;
  readonly projectRoot?: string;
  readonly projectTrusted?: boolean;
  readonly managedAllowlist?: ReadonlySet<string>;
  readonly managedDenylist?: ReadonlySet<string>;
  readonly requireIntegrity?: boolean;
  readonly adapterRegistry?: ExtensionAdapterRegistry;
}

export interface ExtensionInstallRequest {
  readonly source: string;
  readonly scope: "user" | "project";
  readonly yes?: boolean | undefined;
  readonly expectedId?: string | undefined;
  readonly preserveEnabledState?: boolean | undefined;
}

export interface ExtensionUpdateRequest {
  readonly id: string;
  readonly source?: string | undefined;
  readonly scope: "user" | "project";
  readonly yes?: boolean | undefined;
}

export interface ExtensionInstallResult {
  readonly record: ExtensionLockRecord;
  readonly descriptor: ExtensionDescriptor;
}

export interface ExtensionListEntry extends ExtensionDescriptor {}

export interface ExtensionToggleOptions {
  readonly temporary?: boolean | undefined;
}

export class ExtensionManager {
  readonly #options: ExtensionManagerOptions;
  readonly #adapterRegistry: ExtensionAdapterRegistry;
  readonly #temporaryEnabled = new Set<string>();
  readonly #temporaryDisabled = new Set<string>();
  readonly #activeLoaders = new Set<PluginLoader>();

  constructor(options: ExtensionManagerOptions) {
    this.#options = options;
    this.#adapterRegistry = options.adapterRegistry ?? createDefaultExtensionAdapterRegistry();
  }

  async inspect(source: string): Promise<ExtensionInspectResult> {
    const prepared = await this.#prepareSourcePackage(parseExtensionSource(source));
    try {
      return await this.#adapterRegistry.inspect(prepared.packageRoot, prepared.source);
    } finally {
      await prepared.cleanup();
    }
  }

  async install(request: ExtensionInstallRequest): Promise<ExtensionInstallResult> {
    if (request.yes !== true) {
      throw new Error("Extension installation requires confirmation (--yes)");
    }

    const source = parseExtensionSource(request.source);
    const prepared = await this.#prepareSourcePackage(source);
    try {
      const inspection = await this.#adapterRegistry.inspect(prepared.packageRoot, prepared.source);
      this.#assertAllowed(inspection.manifest);

      if (request.scope === "project" && !this.#options.projectTrusted) {
        throw new Error("Project extensions are not trusted in this workspace");
      }

      if (request.expectedId !== undefined && request.expectedId !== inspection.manifest.id) {
        throw new Error(`Extension id mismatch: expected ${request.expectedId}, got ${inspection.manifest.id}`);
      }

      const scopeRoot = this.#scopeRoot(request.scope);
      const installRoot = resolve(scopeRoot, "extensions", inspection.manifest.id);
      const stagingRoot = await this.#createStageRoot(scopeRoot, inspection.manifest.id);
      await copyDirectory(prepared.packageRoot, stagingRoot);
      await this.#validatePackageTree(stagingRoot);

      const existing = await this.#findRecord(request.scope, inspection.manifest.id);
      const enabled = request.preserveEnabledState === true ? (existing?.enabled ?? false) : false;
      const sourceRecord = this.#normalizeSource(prepared.source, inspection);
      const record = this.#buildRecord({
        scope: request.scope,
        source: sourceRecord,
        packageRoot: installRoot,
        inspection,
        enabled,
        current: existing,
      });

      const backup = await this.#replaceDirectoryWithBackup(installRoot, stagingRoot);
      try {
        await this.#writeLockRecord(request.scope, record);
      } catch (error) {
        await this.#restoreDirectoryFromBackup(installRoot, backup);
        throw error;
      } finally {
        this.#temporaryEnabled.delete(record.id);
        this.#temporaryDisabled.delete(record.id);
      }

      return { record, descriptor: this.#toDescriptor(record) };
    } finally {
      await prepared.cleanup();
    }
  }

  async update(request: ExtensionUpdateRequest): Promise<ExtensionInstallResult> {
    const current = await this.#findRecord(request.scope, request.id);
    if (!current) {
      throw new Error(`Extension not found: ${request.id}`);
    }
    const source = request.source ?? this.#sourceToString(current.source);
    return await this.install({
      source,
      scope: request.scope,
      yes: request.yes,
      expectedId: request.id,
      preserveEnabledState: true,
    });
  }

  async enable(id: string, scope: "user" | "project", options: ExtensionToggleOptions = {}): Promise<ExtensionLockRecord> {
    const record = await this.#getRecord(scope, id);
    if (options.temporary === true) {
      this.#temporaryDisabled.delete(id);
      this.#temporaryEnabled.add(id);
      return this.#withEnabledState(record, true);
    }
    const next = this.#withEnabledState(record, true);
    await this.#writeLockRecord(scope, next);
    this.#temporaryDisabled.delete(id);
    this.#temporaryEnabled.delete(id);
    return next;
  }

  async disable(id: string, scope: "user" | "project", options: ExtensionToggleOptions = {}): Promise<ExtensionLockRecord> {
    const record = await this.#getRecord(scope, id);
    if (options.temporary === true) {
      this.#temporaryEnabled.delete(id);
      this.#temporaryDisabled.add(id);
      await this.#unloadFromActiveLoaders(id);
      return this.#withEnabledState(record, false);
    }
    const next = this.#withEnabledState(record, false);
    await this.#writeLockRecord(scope, next);
    this.#temporaryEnabled.delete(id);
    this.#temporaryDisabled.delete(id);
    await this.#unloadFromActiveLoaders(id);
    return next;
  }

  async remove(id: string, scope: "user" | "project"): Promise<boolean> {
    const record = await this.#getRecord(scope, id);
    if (record.enabled) {
      throw new Error(`Extension must be disabled before removal: ${id}`);
    }
    await this.#unloadFromActiveLoaders(id);
    const scopeRoot = this.#scopeRoot(scope);
    const installRoot = resolve(scopeRoot, "extensions", id);
    const backupPath = await maybeRenameExisting(installRoot, `${installRoot}.rm-${process.pid}-${Date.now()}`);
    try {
      const lock = await this.#readLock(scope);
      await this.#writeLock(scope, {
        schemaVersion: "extensions/v1",
        updatedAt: new Date().toISOString(),
        records: lock.records.filter((entry: ExtensionLockRecord) => entry.id !== id),
      });
      this.#temporaryEnabled.delete(id);
      this.#temporaryDisabled.delete(id);
      if (backupPath !== undefined) {
        await rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
      }
      return true;
    } catch (error) {
      if (backupPath !== undefined) {
        await rename(backupPath, installRoot).catch(() => undefined);
      }
      throw error;
    }
  }

  async list(scope?: "user" | "project"): Promise<readonly ExtensionDescriptor[]> {
    const records = await this.#readRecords(scope);
    return records.map((record) => this.#toDescriptor(record));
  }

  async listInstalledRecords(scope?: "user" | "project"): Promise<readonly ExtensionLockRecord[]> {
    return await this.#readRecords(scope);
  }

  async doctor(): Promise<string> {
    const descriptors = await this.list();
    if (descriptors.length === 0) {
      return "No extensions are installed.";
    }
    const lines: string[] = [];
    for (const entry of descriptors) {
      const issues = await this.#diagnose(entry);
      lines.push([
        `${entry.id}\t${entry.version}\t${entry.scope}\t${entry.enabled ? "enabled" : "disabled"}`,
        `adapter: ${entry.adapterId}`,
        `source: ${this.#sourceToString(entry.source)}`,
        `health: ${entry.health}`,
        ...(issues.length > 0 ? [`issues: ${issues.join("; ")}`] : []),
      ].join("\n"));
    }
    return lines.join("\n\n");
  }

  async loadEnabledExtensions(loader: PluginLoader, scope?: "user" | "project"): Promise<readonly string[]> {
    this.#activeLoaders.add(loader);
    const records = await this.#readRecords(scope);
    const loaded: string[] = [];
    for (const record of records) {
      if (!record.enabled) continue;
      if (loader.has(record.id)) {
        loaded.push(record.id);
        continue;
      }
      const plugin = await this.#adapterRegistry.load(record.packageRoot, record.source);
      await loader.load(plugin);
      loaded.push(record.id);
    }
    return loaded;
  }

  async #unloadFromActiveLoaders(id: string): Promise<void> {
    for (const loader of this.#activeLoaders) {
      await loader.unload(id);
    }
  }

  async inspectLock(scope: "user" | "project"): Promise<ExtensionLockFile> {
    return await this.#readLock(scope);
  }

  async initSkeleton(targetDir: string, name: string): Promise<string> {
    const root = assertSafeLocalPath(targetDir, "Extension init directory");
    const packageName = name.trim() || "sample-extension";
    assertSafeIdentifier(packageName, "Extension name");
    await mkdir(root, { recursive: true });
    const manifestPath = resolve(root, MANIFEST_FILE_NAME);
    const entryPath = resolve(root, "index.js");
    const manifest: ExtensionManifestV1 = {
      apiVersion: "mingxu/plugin-v1",
      id: packageName,
      name: packageName,
      version: "0.1.0",
      kind: "tool",
      entry: "index.js",
      description: "MingXu extension skeleton.",
      contributions: [{ kind: "tool", name: "sample_tool", description: "Sample tool contribution." }],
      adapterId: "mingxu-native",
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(entryPath, `export default {\n  name: ${JSON.stringify(packageName)},\n  manifest: ${JSON.stringify(manifest, null, 2)},\n  async setup() {},\n};\n`, "utf8");
    return `Created extension skeleton in ${root}`;
  }

  #scopeRoot(scope: "user" | "project"): string {
    const root = scope === "user" ? this.#options.userRoot : this.#options.projectRoot;
    if (!root) {
      throw new Error(`${scope} extension scope is not configured`);
    }
    return root;
  }

  #sourceToString(source: ExtensionSource): string {
    return source.path ?? source.locator;
  }

  async #getRecord(scope: "user" | "project", id: string): Promise<ExtensionLockRecord> {
    const record = await this.#findRecord(scope, id);
    if (!record) {
      throw new Error(`Extension not found: ${id}`);
    }
    return record;
  }

  async #findRecord(scope: "user" | "project", id: string): Promise<ExtensionLockRecord | undefined> {
    return (await this.#readRecords(scope)).find((record: ExtensionLockRecord) => record.id === id);
  }

  async #readRecords(scope?: "user" | "project"): Promise<readonly ExtensionLockRecord[]> {
    if (scope) {
      return (await this.#readLock(scope)).records.map((record: ExtensionLockRecord) => this.#applyTemporaryState(record));
    }
    const records = [
      ...(await this.#readLock("user")).records,
      ...(await this.#readLock("project")).records,
    ];
    return records.map((record: ExtensionLockRecord) => this.#applyTemporaryState(record));
  }

  async #prepareSourcePackage(source: ExtensionSource): Promise<{
    readonly source: ExtensionSource;
    readonly packageRoot: string;
    readonly cleanup: () => Promise<void>;
  }> {
    if (source.kind === "directory") {
      const root = assertSafeLocalPath(source.path ?? source.locator, "Extension source");
      const resolvedRoot = await realpathOrResolved(root);
      await this.#assertDirectory(resolvedRoot);
      return {
        source: {
          kind: "directory",
          locator: source.locator,
          path: resolvedRoot,
        },
        packageRoot: resolvedRoot,
        cleanup: async () => undefined,
      };
    }

    const stagingRoot = await mkdtemp(join(tmpdir(), "mingxu-extension-source-"));
    try {
      if (source.kind === "tarball") {
        await extractArchive(source.locator, stagingRoot);
      } else if (source.kind === "npm") {
        const tarball = await packNpmPackage(source.locator, stagingRoot);
        const extractRoot = resolve(stagingRoot, "extract");
        await extractArchive(tarball, extractRoot);
      } else if (source.kind === "git") {
        await cloneGitCommit(source.locator, source.commit, stagingRoot);
      } else {
        throw new Error(`Unsupported extension source: ${source.kind}`);
      }
      const packageRoot = await findExtractedPackageSource(stagingRoot, source);
      return {
        source: {
          kind: "directory",
          locator: packageRoot,
          path: packageRoot,
          ...(source.integrity !== undefined ? { integrity: source.integrity } : {}),
          ...(source.commit !== undefined ? { commit: source.commit } : {}),
        },
        packageRoot,
        cleanup: async () => {
          await rm(stagingRoot, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #assertDirectory(path: string): Promise<void> {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      throw new Error(`Extension source must be a directory: ${path}`);
    }
  }

  async #validatePackageTree(root: string): Promise<void> {
    await walkTree(root);
  }

  #normalizeSource(source: ExtensionSource, inspection: ExtensionInspectResult): ExtensionSource {
    return {
      kind: source.kind === "directory" ? "directory" : source.kind,
      locator: source.locator,
      ...(source.path !== undefined ? { path: source.path } : { path: inspection.packageRoot }),
      ...(source.integrity !== undefined ? { integrity: source.integrity } : {}),
      ...(source.commit !== undefined ? { commit: source.commit } : {}),
    };
  }

  #buildRecord(input: {
    scope: "user" | "project";
    source: ExtensionSource;
    packageRoot: string;
    inspection: ExtensionInspectResult;
    enabled: boolean;
    current?: ExtensionLockRecord | undefined;
  }): ExtensionLockRecord {
    const now = new Date().toISOString();
    const { manifest } = input.inspection;
    const manifestPath = remapInspectedPath(input.packageRoot, input.inspection.packageRoot, input.inspection.manifestPath);
    const entryPath = remapInspectedPath(input.packageRoot, input.inspection.packageRoot, input.inspection.entryPath);
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      adapterId: input.inspection.adapterId,
      scope: input.scope,
      enabled: input.enabled,
      source: input.source,
      packageRoot: input.packageRoot,
      manifestPath,
      entryPath,
      manifestHash: input.inspection.manifestHash,
      sha256: input.inspection.sha256,
      ...(manifest.permissions !== undefined ? { permissions: manifest.permissions } : {}),
      contributions: manifest.contributions,
      health: "healthy",
      installedAt: input.current?.installedAt ?? now,
      updatedAt: now,
      ...(input.inspection.upstreamId !== undefined ? { upstreamId: input.inspection.upstreamId } : {}),
      ...(input.inspection.upstreamVersion !== undefined ? { upstreamVersion: input.inspection.upstreamVersion } : {}),
      ...(input.inspection.upstreamManifestHash !== undefined ? { upstreamManifestHash: input.inspection.upstreamManifestHash } : {}),
      ...(input.inspection.capabilities !== undefined ? { capabilities: input.inspection.capabilities } : {}),
      ...(input.inspection.unsupportedCapabilities !== undefined ? { unsupportedCapabilities: input.inspection.unsupportedCapabilities } : {}),
    };
  }

  #withEnabledState(record: ExtensionLockRecord, enabled: boolean): ExtensionLockRecord {
    return {
      ...record,
      enabled,
      updatedAt: new Date().toISOString(),
    };
  }

  #applyTemporaryState(record: ExtensionLockRecord): ExtensionLockRecord {
    if (this.#temporaryEnabled.has(record.id)) {
      return { ...record, enabled: true };
    }
    if (this.#temporaryDisabled.has(record.id)) {
      return { ...record, enabled: false };
    }
    return record;
  }

  #toDescriptor(record: ExtensionLockRecord): ExtensionDescriptor {
    return {
      id: record.id,
      name: record.name,
      version: record.version,
      adapterId: record.adapterId,
      scope: record.scope,
      enabled: record.enabled,
      source: record.source,
      packageRoot: record.packageRoot,
      manifestPath: record.manifestPath,
      entryPath: record.entryPath,
      manifestHash: record.manifestHash,
      sha256: record.sha256,
      ...(record.permissions !== undefined ? { permissions: record.permissions } : {}),
      contributions: record.contributions,
      health: record.health,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      ...(record.upstreamId !== undefined ? { upstreamId: record.upstreamId } : {}),
      ...(record.upstreamVersion !== undefined ? { upstreamVersion: record.upstreamVersion } : {}),
      ...(record.upstreamManifestHash !== undefined ? { upstreamManifestHash: record.upstreamManifestHash } : {}),
      ...(record.capabilities !== undefined ? { capabilities: record.capabilities } : {}),
      ...(record.unsupportedCapabilities !== undefined ? { unsupportedCapabilities: record.unsupportedCapabilities } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }

  #assertAllowed(manifest: ExtensionManifestV1): void {
    if (this.#options.managedAllowlist && !this.#options.managedAllowlist.has(manifest.id)) {
      throw new Error(`Extension is not allowlisted: ${manifest.id}`);
    }
    if (this.#options.managedDenylist?.has(manifest.id)) {
      throw new Error(`Extension is denied by policy: ${manifest.id}`);
    }
  }

  async #diagnose(descriptor: ExtensionDescriptor): Promise<string[]> {
    const issues: string[] = [];
    try {
      await this.#assertFileExists(descriptor.packageRoot);
      await this.#assertFileExists(descriptor.manifestPath);
      await this.#assertFileExists(descriptor.entryPath);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      return issues;
    }

    const manifest = await readManifestFile(descriptor.packageRoot);
    if (sha256Hex(stableStringify(manifest)) !== descriptor.manifestHash) {
      issues.push("manifest hash mismatch");
    }
    const packageHash = await hashDirectory(descriptor.packageRoot);
    if (packageHash !== descriptor.sha256) {
      issues.push("package hash mismatch");
    }
    if (manifest.id !== descriptor.id) {
      issues.push("manifest id mismatch");
    }
    if (manifest.version !== descriptor.version) {
      issues.push("manifest version mismatch");
    }
    if (manifest.adapterId !== undefined && manifest.adapterId !== descriptor.adapterId) {
      issues.push("adapter mismatch");
    }
    return issues;
  }

  async #assertFileExists(path: string): Promise<void> {
    const stats = await stat(path);
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new Error(`Missing installed extension path: ${path}`);
    }
  }

  async #readLock(scope: "user" | "project"): Promise<ExtensionLockFile> {
    const root = this.#scopeRoot(scope);
    const lockPath = resolve(root, LOCK_FILE_NAME);
    try {
      const text = await readFile(lockPath, "utf8");
      const parsed = JSON.parse(text) as Partial<ExtensionLockFile> & { records?: unknown };
      if (parsed.schemaVersion !== "extensions/v1" || !Array.isArray(parsed.records)) {
        throw new Error(`Invalid extension lock file: ${lockPath}`);
      }
      return {
        schemaVersion: "extensions/v1",
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
        records: parsed.records.map((record: unknown) => normalizeLockRecord(record)),
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { schemaVersion: "extensions/v1", updatedAt: new Date(0).toISOString(), records: [] };
      }
      throw error;
    }
  }

  async #writeLock(scope: "user" | "project", lock: ExtensionLockFile): Promise<void> {
    const root = this.#scopeRoot(scope);
    await mkdir(root, { recursive: true });
    const lockPath = resolve(root, LOCK_FILE_NAME);
    const tempPath = `${lockPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    const backupPath = await maybeRenameExisting(lockPath, `${lockPath}.bak-${process.pid}-${Date.now()}`);
    try {
      await rename(tempPath, lockPath);
      if (backupPath !== undefined) {
        await rm(backupPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      await rm(lockPath, { force: true }).catch(() => undefined);
      if (backupPath !== undefined) {
        await rename(backupPath, lockPath).catch(() => undefined);
      }
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #writeLockRecord(scope: "user" | "project", record: ExtensionLockRecord): Promise<void> {
    const lock = await this.#readLock(scope);
    const index = lock.records.findIndex((entry: ExtensionLockRecord) => entry.id === record.id);
    const nextRecords = index >= 0
      ? lock.records.map((entry: ExtensionLockRecord, entryIndex: number) => entryIndex === index ? record : entry)
      : [...lock.records, record];
    await this.#writeLock(scope, {
      schemaVersion: "extensions/v1",
      updatedAt: new Date().toISOString(),
      records: nextRecords,
    });
  }

  async #replaceDirectoryWithBackup(destination: string, sourceRoot: string): Promise<string | undefined> {
    await mkdir(dirname(destination), { recursive: true });
    const backupPath = `${destination}.bak-${process.pid}-${Date.now()}`;
    try {
      await maybeRenameExisting(destination, backupPath);
      await rename(sourceRoot, destination);
      return backupPath;
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      if (await exists(backupPath)) {
        await rename(backupPath, destination).catch(() => undefined);
      }
      throw error;
    }
  }

  async #restoreDirectoryFromBackup(destination: string, backupPath: string | undefined): Promise<void> {
    if (!backupPath) return;
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    await rename(backupPath, destination).catch(() => undefined);
  }

  async #createStageRoot(scopeRoot: string, id: string): Promise<string> {
    const stagingParent = resolve(scopeRoot, "extensions", ".staging");
    await mkdir(stagingParent, { recursive: true });
    return await mkdtemp(join(stagingParent, `${id}-`));
  }
}

function parseExtensionSource(value: string): ExtensionSource {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Extension source cannot be empty");
  }
  if (trimmed.startsWith("npm:")) {
    const spec = trimmed.slice("npm:".length);
    const match = /^(@?[^@/]+(?:\/[^@/]+)?|[^@/]+)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(spec);
    if (!match) {
      throw new Error("npm extension sources must use an exact version, for example npm:@scope/pkg@1.2.3");
    }
    return { kind: "npm", locator: spec };
  }
  if (trimmed.startsWith("git+https://")) {
    const hashIndex = trimmed.lastIndexOf("#");
    if (hashIndex < 0) {
      throw new Error("git extension sources must pin a commit SHA");
    }
    const url = trimmed.slice(0, hashIndex);
    const commit = trimmed.slice(hashIndex + 1);
    if (!/^git\+https:\/\/[^#]+$/u.test(url) || !/^[0-9a-fA-F]{40}$/u.test(commit)) {
      throw new Error("git extension sources must use HTTPS and a full 40-character commit SHA");
    }
    return { kind: "git", locator: url, commit };
  }
  if (looksLikeArchive(trimmed)) {
    return { kind: "tarball", locator: trimmed };
  }
  return { kind: "directory", locator: trimmed, path: trimmed };
}

function looksLikeArchive(value: string): boolean {
  const lower = value.toLowerCase();
  return SUPPORTED_ARCHIVE_EXTENSIONS.has(extname(lower)) || lower.endsWith(".tar.gz");
}

function normalizeLockRecord(value: unknown): ExtensionLockRecord {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid extension lock record");
  }
  const record = value as Partial<ExtensionLockRecord>;
  if (!record.source || typeof record.source !== "object") {
    throw new Error("Invalid extension lock record source");
  }
  return {
    id: String(record.id ?? "").trim(),
    name: String(record.name ?? "").trim(),
    version: String(record.version ?? "").trim(),
    adapterId: String(record.adapterId ?? "").trim(),
    scope: record.scope === "project" ? "project" : "user",
    enabled: record.enabled === true,
    source: record.source as ExtensionSource,
    packageRoot: String(record.packageRoot ?? "").trim(),
    manifestPath: String(record.manifestPath ?? "").trim(),
    entryPath: String(record.entryPath ?? "").trim(),
    manifestHash: String(record.manifestHash ?? "").trim(),
    sha256: String(record.sha256 ?? "").trim(),
    ...(record.permissions !== undefined ? { permissions: record.permissions } : {}),
    contributions: Array.isArray(record.contributions) ? record.contributions : [],
    health: record.health === "unhealthy" ? "unhealthy" : record.health === "unknown" ? "unknown" : "healthy",
    installedAt: String(record.installedAt ?? new Date(0).toISOString()),
    updatedAt: String(record.updatedAt ?? new Date(0).toISOString()),
    ...(record.upstreamId !== undefined ? { upstreamId: String(record.upstreamId) } : {}),
    ...(record.upstreamVersion !== undefined ? { upstreamVersion: String(record.upstreamVersion) } : {}),
    ...(record.upstreamManifestHash !== undefined ? { upstreamManifestHash: String(record.upstreamManifestHash) } : {}),
    ...(Array.isArray(record.capabilities) ? { capabilities: record.capabilities.map(String) } : {}),
    ...(Array.isArray(record.unsupportedCapabilities) ? { unsupportedCapabilities: record.unsupportedCapabilities.map(String) } : {}),
    ...(record.error !== undefined ? { error: String(record.error) } : {}),
  };
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  const resolvedArchive = assertSafeLocalPath(archivePath, "Extension archive");
  const resolvedDestination = assertSafeLocalPath(destination, "Extension archive destination");
  await mkdir(resolvedDestination, { recursive: true });
  const { stdout } = await execFileAsync("tar", ["-tf", resolvedArchive], { encoding: "utf8" });
  validateArchiveEntries(stdout.toString());
  const extractArgs = resolvedArchive.toLowerCase().endsWith(".tar") ? ["-xf", resolvedArchive, "-C", resolvedDestination] : ["-xzf", resolvedArchive, "-C", resolvedDestination];
  await execFileAsync("tar", extractArgs, { encoding: "utf8" });
  await validateTreeAfterExtract(resolvedDestination);
}

async function packNpmPackage(locator: string, destination: string): Promise<string> {
  await mkdir(destination, { recursive: true });
  const view = await execFileAsync("npm", ["view", locator, "dist.integrity", "dist.tarball", "--json"], { encoding: "utf8" });
  const metadata = JSON.parse(view.stdout.toString()) as { dist?: { integrity?: string } };
  const integrity = metadata.dist?.integrity;
  if (!integrity) {
    throw new Error(`npm package did not publish dist.integrity: ${locator}`);
  }
  const pack = await execFileAsync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination, locator], { encoding: "utf8" });
  const parsed = JSON.parse(pack.stdout.toString()) as Array<{ filename?: string }>;
  const filename = parsed[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack did not return a tarball for ${locator}`);
  }
  const tarball = resolve(destination, filename);
  const actualIntegrity = await computeIntegrity(tarball);
  if (actualIntegrity !== integrity) {
    throw new Error(`npm integrity mismatch for ${locator}`);
  }
  return tarball;
}

async function cloneGitCommit(locator: string, commit: string | undefined, destination: string): Promise<void> {
  if (!locator.startsWith("git+https://")) {
    throw new Error("git extension sources must use git+https://");
  }
  const httpsUrl = locator.slice("git+".length);
  await execFileAsync("git", ["clone", "--no-checkout", httpsUrl, destination], { encoding: "utf8" });
  if (!commit) {
    throw new Error("git extension sources must pin a commit SHA");
  }
  await execFileAsync("git", ["-C", destination, "checkout", commit], { encoding: "utf8" });
  const resolvedCommit = (await execFileAsync("git", ["-C", destination, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.toString().trim();
  if (resolvedCommit !== commit) {
    throw new Error(`git checkout resolved to a different commit: ${resolvedCommit}`);
  }
}

async function findExtractedPackageSource(root: string, source: ExtensionSource): Promise<string> {
  const manifestPath = await findManifestPath(root);
  if (!manifestPath) {
    throw new Error(`Extension manifest not found in extracted source: ${source.locator}`);
  }
  return dirname(manifestPath);
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function validateTreeAfterExtract(root: string): Promise<void> {
  const entries = await walkTree(root);
  for (const entry of entries) {
    const relativePath = relative(root, entry.path);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Archive contains an unsafe path: ${entry.path}`);
    }
    if (entry.isSymbolicLink) {
      throw new Error(`Archive contains a symbolic link: ${relativePath}`);
    }
  }
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

async function findManifestPath(root: string): Promise<string | undefined> {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const manifestPath = resolve(current, MANIFEST_FILE_NAME);
    try {
      const manifestStats = await stat(manifestPath);
      if (manifestStats.isFile()) {
        return manifestPath;
      }
    } catch {
      // keep searching
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        stack.push(resolve(current, entry.name));
      }
    }
  }
  return undefined;
}

function validateArchiveEntries(listing: string): void {
  for (const line of listing.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cleaned = trimmed.replace(/^\.\/+/u, "");
    if (cleaned.startsWith("/") || cleaned.includes("..")) {
      throw new Error(`Archive contains an unsafe path: ${trimmed}`);
    }
  }
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

async function computeIntegrity(filePath: string): Promise<string> {
  const hash = createHash("sha512");
  const buffer = await readFile(filePath);
  hash.update(buffer);
  return `sha512-${hash.digest("base64")}`;
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

function remapInspectedPath(destinationRoot: string, inspectedRoot: string, inspectedPath: string): string {
  const relativePath = relative(inspectedRoot, inspectedPath);
  return resolve(destinationRoot, relativePath);
}

async function readManifestFile(packageRoot: string): Promise<ExtensionManifestV1> {
  const manifestPath = resolve(packageRoot, MANIFEST_FILE_NAME);
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<ExtensionManifestV1>;
  return {
    apiVersion: parsed.apiVersion ?? "mingxu/plugin-v1",
    id: String(parsed.id ?? "").trim(),
    name: String(parsed.name ?? "").trim(),
    version: String(parsed.version ?? "").trim(),
    kind: (parsed.kind ?? "tool") as ExtensionManifestV1["kind"],
    ...(parsed.entry !== undefined ? { entry: parsed.entry } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.configSchema !== undefined ? { configSchema: parsed.configSchema } : {}),
    ...(parsed.permissions !== undefined ? { permissions: parsed.permissions } : {}),
    contributions: Array.isArray(parsed.contributions) ? parsed.contributions : [],
    ...(parsed.adapterId !== undefined ? { adapterId: parsed.adapterId } : {}),
  };
}

async function realpathOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function maybeRenameExisting(source: string, backup: string): Promise<string | undefined> {
  try {
    await access(source);
    await rename(source, backup);
    return backup;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
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

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
