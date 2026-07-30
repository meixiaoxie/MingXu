import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, lstat, realpath, rename } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assertPathInsideRoot, assertSafeIdentifier, assertSafeLocalPath } from "../safety/path-safety.js";
import type { PluginLoader } from "../plugins/plugin-loader.js";
import type {
  ExtensionAdapterV1,
  ExtensionContribution,
  ExtensionDescriptor,
  ExtensionInspectResult,
  ExtensionLockFile,
  ExtensionLockRecord,
  ExtensionManifestV1,
  ExtensionSource,
} from "./protocol.js";

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
}

export interface ExtensionInstallRequest {
  readonly source: string;
  readonly scope: "user" | "project";
  readonly yes?: boolean;
}

export interface ExtensionInstallResult {
  readonly record: ExtensionLockRecord;
  readonly descriptor: ExtensionDescriptor;
}

export interface ExtensionListEntry extends ExtensionDescriptor {}

export class ExtensionManager {
  readonly #options: ExtensionManagerOptions;

  constructor(options: ExtensionManagerOptions) {
    this.#options = options;
  }

  async inspect(source: string): Promise<ExtensionInspectResult> {
    return await this.#inspectSource(parseExtensionSource(source));
  }

  async install(request: ExtensionInstallRequest): Promise<ExtensionInstallResult> {
    const source = parseExtensionSource(request.source);
    const inspection = await this.#inspectSource(source);
    this.#assertAllowed(inspection.manifest);

    if (request.scope === "project" && !this.#options.projectTrusted) {
      throw new Error("Project extensions are not trusted in this workspace");
    }

    const scopeRoot = this.#scopeRoot(request.scope);
    const installRoot = resolve(scopeRoot, "extensions", inspection.manifest.id);
    const stagingRoot = await mkdtemp(join(tmpdir(), "mingxu-extension-"));
    const stagedPackageRoot = resolve(stagingRoot, inspection.manifest.id);
    await mkdir(dirname(stagedPackageRoot), { recursive: true });

    try {
      await cp(inspection.packageRoot, stagedPackageRoot, { recursive: true, force: true });
      await this.#validatePackageTree(stagedPackageRoot, inspection.manifest);

      const record = this.#toRecord({
        scope: request.scope,
        source,
        packageRoot: stagedPackageRoot,
        inspection,
        enabled: true,
      });

      await this.#replaceExtensionTree(installRoot, stagedPackageRoot);
      await this.#writeLockRecord(request.scope, record);

      const descriptor = this.#toDescriptor(record);
      return { record, descriptor };
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async enable(id: string, scope: "user" | "project"): Promise<ExtensionLockRecord> {
    return await this.#setEnabled(id, scope, true);
  }

  async disable(id: string, scope: "user" | "project"): Promise<ExtensionLockRecord> {
    return await this.#setEnabled(id, scope, false);
  }

  async remove(id: string, scope: "user" | "project"): Promise<boolean> {
    const lock = await this.#readLock(scope);
    const record = lock.records.find((entry) => entry.id === id);
    if (!record) return false;

    const scopeRoot = this.#scopeRoot(scope);
    await rm(resolve(scopeRoot, "extensions", id), { recursive: true, force: true });
    await this.#writeLock(scope, {
      schemaVersion: "extensions/v1",
      updatedAt: new Date().toISOString(),
      records: lock.records.filter((entry) => entry.id !== id),
    });
    return true;
  }

  async list(scope?: "user" | "project"): Promise<readonly ExtensionDescriptor[]> {
    if (scope) {
      return (await this.#readLock(scope)).records.map((record) => this.#toDescriptor(record));
    }
    const records = [...(await this.#readLock("user")).records, ...(await this.#readLock("project")).records];
    return records.map((record) => this.#toDescriptor(record));
  }

  async listInstalledRecords(scope?: "user" | "project"): Promise<readonly ExtensionLockRecord[]> {
    if (scope) {
      return (await this.#readLock(scope)).records;
    }
    return [...(await this.#readLock("user")).records, ...(await this.#readLock("project")).records];
  }

  async doctor(): Promise<string> {
    const descriptors = await this.list();
    if (descriptors.length === 0) {
      return "No extensions are installed.";
    }
    return descriptors
      .map((entry) => [
        `${entry.id}\t${entry.version}\t${entry.scope}\t${entry.enabled ? "enabled" : "disabled"}`,
        `adapter: ${entry.adapterId}`,
        `source: ${entry.source.kind}:${entry.source.locator}`,
        `health: ${entry.health}`,
      ].join("\n"))
      .join("\n\n");
  }

  async loadEnabledExtensions(loader: PluginLoader, scope?: "user" | "project"): Promise<readonly string[]> {
    const records = await this.listInstalledRecords(scope);
    const loaded: string[] = [];
    for (const record of records) {
      if (!record.enabled) continue;
      const descriptor = this.#toDescriptor(record);
      await loader.load({
        path: descriptor.packageRoot,
        trust: "trusted_local",
        manifest: descriptor.name,
      });
      loaded.push(descriptor.id);
    }
    return loaded;
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

  async #setEnabled(id: string, scope: "user" | "project", enabled: boolean): Promise<ExtensionLockRecord> {
    const lock = await this.#readLock(scope);
    const index = lock.records.findIndex((record) => record.id === id);
    if (index < 0) {
      throw new Error(`Extension not found: ${id}`);
    }
    const current = lock.records[index]!;
    const nextRecord: ExtensionLockRecord = {
      id: current.id,
      name: current.name,
      version: current.version,
      adapterId: current.adapterId,
      scope: current.scope,
      enabled,
      source: current.source,
      packageRoot: current.packageRoot,
      manifestPath: current.manifestPath,
      entryPath: current.entryPath,
      manifestHash: current.manifestHash,
      sha256: current.sha256,
      ...(current.permissions !== undefined ? { permissions: current.permissions } : {}),
      contributions: current.contributions,
      installedAt: current.installedAt,
      updatedAt: new Date().toISOString(),
      ...(current.error !== undefined ? { error: current.error } : {}),
    };
    const nextRecords = [...lock.records];
    nextRecords[index] = nextRecord;
    await this.#writeLock(scope, {
      schemaVersion: "extensions/v1",
      updatedAt: new Date().toISOString(),
      records: nextRecords,
    });
    return nextRecord;
  }

  async #inspectSource(source: ExtensionSource): Promise<ExtensionInspectResult> {
    if (source.kind === "directory") {
      return await this.#inspectDirectorySource(source);
    }
    if (source.kind === "tarball") {
      const stagingRoot = await mkdtemp(join(tmpdir(), "mingxu-extension-archive-"));
      try {
        await extractArchive(source.locator, stagingRoot);
        return await this.#inspectDirectorySource(await findExtractedPackageSource(stagingRoot, source));
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    }
    if (source.kind === "npm") {
      const stagingRoot = await mkdtemp(join(tmpdir(), "mingxu-extension-npm-"));
      try {
        const tarball = await packNpmPackage(source.locator, stagingRoot);
        const extractRoot = resolve(stagingRoot, "extract");
        await extractArchive(tarball, extractRoot);
        return await this.#inspectDirectorySource(await findExtractedPackageSource(extractRoot, source));
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    }
    if (source.kind === "git") {
      const stagingRoot = await mkdtemp(join(tmpdir(), "mingxu-extension-git-"));
      try {
        await cloneGitCommit(source.locator, source.commit, stagingRoot);
        return await this.#inspectDirectorySource(await findExtractedPackageSource(stagingRoot, source));
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    }
    throw new Error(`Unsupported extension source: ${source.kind}`);
  }

  async #inspectDirectorySource(source: ExtensionSource): Promise<ExtensionInspectResult> {
    const root = source.path ?? source.locator;
    if (!root) {
      throw new Error("Extension source path is empty");
    }
    const resolvedRoot = assertSafeLocalPath(root, "Extension source");
    const rootStat = await stat(resolvedRoot);
    if (!rootStat.isDirectory()) {
      throw new Error(`Extension source must be a directory: ${root}`);
    }
    const manifestPath = resolve(resolvedRoot, MANIFEST_FILE_NAME);
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = parseManifest(manifestRaw);
    const entryPath = resolve(resolvedRoot, manifest.entry ?? "index.js");
    await assertPathInsideRoot(resolvedRoot, entryPath, "Extension entry");
    await stat(entryPath);
    const normalizedManifest = JSON.stringify(manifest, Object.keys(manifest).sort(), 2);
    const manifestHash = sha256Hex(normalizedManifest);
    const packageHash = await hashDirectory(resolvedRoot);
    return {
      manifest,
      packageRoot: resolvedRoot,
      manifestPath,
      entryPath,
      manifestHash,
      sha256: packageHash,
      source,
    };
  }

  async #replaceExtensionTree(destination: string, sourceRoot: string): Promise<void> {
    await rm(destination, { recursive: true, force: true });
    await mkdir(dirname(destination), { recursive: true });
    await cp(sourceRoot, destination, { recursive: true, force: true });
    await this.#validatePackageTree(destination, parseManifest(await readFile(resolve(destination, MANIFEST_FILE_NAME), "utf8")));
  }

  async #validatePackageTree(root: string, manifest: ExtensionManifestV1): Promise<void> {
    const entries = await walkTree(root);
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
        throw new Error(`Extension package exceeds total size limit: ${manifest.id}`);
      }
    }
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
      health: record.error ? "unhealthy" : "healthy",
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }

  #toRecord(input: {
    scope: "user" | "project";
    source: ExtensionSource;
    packageRoot: string;
    inspection: ExtensionInspectResult;
    enabled: boolean;
  }): ExtensionLockRecord {
    const { manifest } = input.inspection;
    const now = new Date().toISOString();
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      adapterId: "mingxu-native",
      scope: input.scope,
      enabled: input.enabled,
      source: input.source,
      packageRoot: input.packageRoot,
      manifestPath: input.inspection.manifestPath,
      entryPath: input.inspection.entryPath,
      manifestHash: input.inspection.manifestHash,
      sha256: input.inspection.sha256,
      ...(manifest.permissions !== undefined ? { permissions: manifest.permissions } : {}),
      contributions: manifest.contributions ?? [],
      installedAt: now,
      updatedAt: now,
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
        records: parsed.records.map((record) => normalizeLockRecord(record)),
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
    await rm(lockPath, { force: true }).catch(() => undefined);
    await rename(tempPath, lockPath);
  }

  async #writeLockRecord(scope: "user" | "project", record: ExtensionLockRecord): Promise<void> {
    const lock = await this.#readLock(scope);
    const index = lock.records.findIndex((entry) => entry.id === record.id);
    const nextRecords = index >= 0
      ? lock.records.map((entry, entryIndex) => entryIndex === index ? record : entry)
      : [...lock.records, record];
    await this.#writeLock(scope, {
      schemaVersion: "extensions/v1",
      updatedAt: new Date().toISOString(),
      records: nextRecords,
    });
  }
}

function parseExtensionSource(value: string): ExtensionSource {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Extension source cannot be empty");
  }
  if (trimmed.startsWith("npm:")) {
    const spec = trimmed.slice("npm:".length);
    const match = /^(@?[^@/]+(?:\/[^@/]+)?|[^@/]+)@(\d+\.\d+\.\d+(?:[-+][^@/]+)?)$/u.exec(spec);
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
    if (!/^git\+https:\/\/[^#]+$/u.test(url) || !/^[0-9a-fA-F]{7,40}$/u.test(commit)) {
      throw new Error("git extension sources must use HTTPS and a commit SHA");
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

function parseManifest(source: string): ExtensionManifestV1 {
  const parsed = JSON.parse(source) as Partial<ExtensionManifestV1>;
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
  if (parsed.entry !== undefined && typeof parsed.entry !== "string") {
    throw new Error("Extension manifest entry must be a string");
  }
  if (parsed.permissions !== undefined && typeof parsed.permissions !== "object") {
    throw new Error("Extension manifest permissions must be an object");
  }
  return {
    apiVersion: "mingxu/plugin-v1",
    id: parsed.id.trim(),
    name: parsed.name.trim(),
    version: parsed.version.trim(),
    kind: parsed.kind,
    ...(parsed.entry !== undefined ? { entry: parsed.entry } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.configSchema !== undefined ? { configSchema: parsed.configSchema } : {}),
    ...(parsed.permissions !== undefined ? { permissions: parsed.permissions } : {}),
    contributions: normalizeContributions(parsed.contributions),
  };
}

function normalizeContributions(value: unknown): readonly ExtensionContribution[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Partial<{ kind: ExtensionManifestV1["kind"]; name: string; description?: string }>;
    if (typeof record.kind !== "string" || typeof record.name !== "string") return [];
    return [{
      kind: record.kind,
      name: record.name,
      ...(record.description !== undefined ? { description: record.description } : {}),
    }];
  });
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
    contributions: Array.isArray(record.contributions) ? record.contributions as readonly ExtensionContribution[] : [],
    installedAt: String(record.installedAt ?? new Date(0).toISOString()),
    updatedAt: String(record.updatedAt ?? new Date(0).toISOString()),
    ...(record.error !== undefined ? { error: String(record.error) } : {}),
  };
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  const resolvedArchive = assertSafeLocalPath(archivePath, "Extension archive");
  const resolvedDestination = assertSafeLocalPath(destination, "Extension archive destination");
  await mkdir(resolvedDestination, { recursive: true });
  const { stdout } = await execFileAsync("tar", ["-tf", resolvedArchive], { encoding: "utf8" });
  validateArchiveEntries(stdout.toString());
  await execFileAsync("tar", ["-xzf", resolvedArchive, "-C", resolvedDestination], { encoding: "utf8" });
  await validateTreeAfterExtract(resolvedDestination);
}

async function packNpmPackage(locator: string, destination: string): Promise<string> {
  await mkdir(destination, { recursive: true });
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", destination, locator], { encoding: "utf8" });
  const parsed = JSON.parse(stdout.toString()) as Array<{ filename?: string }>;
  const filename = parsed[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack did not return a tarball for ${locator}`);
  }
  return resolve(destination, filename);
}

async function cloneGitCommit(locator: string, commit: string | undefined, destination: string): Promise<void> {
  if (!locator.startsWith("git+https://")) {
    throw new Error("git extension sources must use git+https://");
  }
  const httpsUrl = locator.slice("git+".length);
  const tempRepo = resolve(destination, "repo");
  await execFileAsync("git", ["clone", "--no-checkout", httpsUrl, tempRepo], { encoding: "utf8" });
  if (!commit) {
    throw new Error("git extension sources must pin a commit SHA");
  }
  await execFileAsync("git", ["-C", tempRepo, "checkout", commit], { encoding: "utf8" });
  await copyDirectory(tempRepo, destination);
  await rm(tempRepo, { recursive: true, force: true });
}

async function findExtractedPackageSource(root: string, source: ExtensionSource): Promise<ExtensionSource> {
  const manifestPath = await findManifestPath(root);
  if (!manifestPath) {
    throw new Error(`Extension manifest not found in extracted source: ${source.locator}`);
  }
  return {
    kind: "directory",
    locator: dirname(manifestPath),
    path: dirname(manifestPath),
  };
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, force: true });
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
  return entries;
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

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
