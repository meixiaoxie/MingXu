import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CODING_TOOL_NAMES = ["read", "list", "search", "write", "edit", "command"];
const MUTATION_PROTOCOL = "mingxu/tool-mutation-v1";
const MAX_DIFF_LINES = 240;
const MAX_DIFF_BYTES = 64 * 1024;

const codingToolEntries = {
  read: {
    name: "read",
    description: "Read a workspace file without changing it.",
    governance: {
      kind: "file",
      action: "read",
      rootDirectory: "workspace",
      pathField: "path",
    },
  },
  list: {
    name: "list",
    description: "List files and directories inside the workspace.",
    governance: {
      kind: "file",
      action: "read",
      rootDirectory: "workspace",
      pathField: "path",
    },
  },
  search: {
    name: "search",
    description: "Search text inside workspace files.",
    governance: {
      kind: "file",
      action: "read",
      rootDirectory: "workspace",
      pathField: "path",
    },
  },
  write: {
    name: "write",
    description: "Write a new workspace file.",
    governance: {
      kind: "file",
      action: "write",
      rootDirectory: "workspace",
      pathField: "path",
    },
  },
  edit: {
    name: "edit",
    description: "Edit an existing workspace file.",
    governance: {
      kind: "file",
      action: "write",
      rootDirectory: "workspace",
      pathField: "path",
    },
  },
  command: {
    name: "command",
    description: "Run a workspace-scoped command with explicit argv.",
    governance: {
      kind: "command",
      action: "exec",
      argvField: "argv",
      cwdField: "cwd",
      envFields: ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "SystemRoot", "ComSpec"],
      timeoutMsField: "timeoutMs",
      maxOutputBytesField: "maxOutputBytes",
    },
  },
};

const codingToolsManifest = {
  apiVersion: "mingxu/plugin-v1",
  id: "mingxu-coding-tools",
  name: "MingXu Coding Tools",
  version: "0.4.0",
  kind: "tool",
  adapterId: "mingxu-native",
  entry: "index.js",
  description: "Official coding tools plugin for workspace-scoped file and command actions.",
  permissions: {
    files: "write",
    commands: "allow",
    network: "none",
  },
  contributions: CODING_TOOL_NAMES.map((name) => ({
    kind: "tool",
    name,
    description: codingToolEntries[name].description,
  })),
};

export {
  CODING_TOOL_NAMES,
  codingToolEntries,
  codingToolsManifest,
};

export function createCodingToolsPlugin(options = {}) {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const mutationSecret = randomBytes(32);
  const atomicReplace = typeof options.atomicReplace === "function" ? options.atomicReplace : rename;

  return {
    name: codingToolsManifest.name,
    manifest: codingToolsManifest,
    async setup(context) {
      const root = await resolveWorkspaceRoot(resolvedWorkspaceRoot);
      for (const tool of createWorkspaceTools(root, { mutationSecret, atomicReplace })) {
        context.registerTool(tool);
      }
    },
    async healthCheck() {
      return true;
    },
  };
}

export const codingToolsPlugin = createCodingToolsPlugin();

export default codingToolsPlugin;

function createWorkspaceTools(workspaceRoot, mutationOptions) {
  return [
    createReadTool(workspaceRoot),
    createListTool(workspaceRoot),
    createSearchTool(workspaceRoot),
    createWriteTool(workspaceRoot, mutationOptions),
    createEditTool(workspaceRoot, mutationOptions),
    createCommandTool(workspaceRoot),
  ];
}

function createReadTool(workspaceRoot) {
  return {
    name: "read",
    description: codingToolEntries.read.description,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        encoding: { enum: ["utf8", "utf-8"] },
      },
      required: ["path"],
    },
    governance: { ...codingToolEntries.read.governance, rootDirectory: workspaceRoot },
    async execute(input, context) {
      context?.signal?.throwIfAborted();
      const path = await resolveReadablePath(workspaceRoot, input.path, "read path");
      const content = await readFile(path, "utf8");
      return {
        kind: "text",
        path: toWorkspaceRelative(workspaceRoot, path),
        encoding: "utf8",
        bytes: Buffer.byteLength(content, "utf8"),
        content,
      };
    },
  };
}

function createListTool(workspaceRoot) {
  return {
    name: "list",
    description: codingToolEntries.list.description,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
    },
    governance: { ...codingToolEntries.list.governance, rootDirectory: workspaceRoot },
    async execute(input, context) {
      context?.signal?.throwIfAborted();
      const target = await resolveExistingDirectoryPath(workspaceRoot, input.path ?? ".", "list path");
      const entries = await listDirectoryEntries(workspaceRoot, target, Boolean(input.recursive));
      return {
        kind: "tree",
        path: toWorkspaceRelative(workspaceRoot, target),
        entries,
      };
    },
  };
}

function createSearchTool(workspaceRoot) {
  return {
    name: "search",
    description: codingToolEntries.search.description,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        pattern: { type: "string" },
        recursive: { type: "boolean" },
        limit: { type: "number" },
        caseSensitive: { type: "boolean" },
      },
      required: ["pattern"],
    },
    governance: { ...codingToolEntries.search.governance, rootDirectory: workspaceRoot },
    async execute(input, context) {
      context?.signal?.throwIfAborted();
      const target = await resolveExistingDirectoryPath(workspaceRoot, input.path ?? ".", "search path");
      const pattern = String(input.pattern ?? "").trim();
      if (!pattern) {
        throw new Error("search requires a non-empty pattern");
      }
      const limit = clampInteger(input.limit, 1, 500, 50);
      const matches = [];
      const searchTerm = input.caseSensitive === true ? pattern : pattern.toLowerCase();
      for await (const filePath of walkWorkspaceFiles(workspaceRoot, target, Boolean(input.recursive), context?.signal)) {
        context?.signal?.throwIfAborted();
        if (matches.length >= limit) {
          break;
        }
        const text = await readUtf8IfSmallEnough(filePath.absolute);
        if (text === undefined) {
          continue;
        }
        const lines = text.split(/\r?\n/u);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          const haystack = input.caseSensitive === true ? line : line.toLowerCase();
          const column = haystack.indexOf(searchTerm);
          if (column >= 0) {
            matches.push({
              path: toWorkspaceRelative(workspaceRoot, filePath.absolute),
              line: lineIndex + 1,
              column: column + 1,
              text: line,
            });
            if (matches.length >= limit) {
              break;
            }
          }
        }
      }
      return {
        kind: "table",
        path: toWorkspaceRelative(workspaceRoot, target),
        pattern,
        caseSensitive: input.caseSensitive === true,
        limit,
        count: matches.length,
        matches,
      };
    },
  };
}

function createWriteTool(workspaceRoot, mutationOptions) {
  return {
    name: "write",
    description: codingToolEntries.write.description,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["path", "content"],
    },
    governance: { ...codingToolEntries.write.governance, rootDirectory: workspaceRoot },
    async prepare(input, context) {
      context?.signal?.throwIfAborted();
      return prepareFileMutation(workspaceRoot, mutationOptions.mutationSecret, "write", input);
    },
    async commit(preparation, context) {
      return commitFileMutation(workspaceRoot, mutationOptions, preparation, context?.signal);
    },
    async execute() {
      throw new Error("write requires the prepare/commit lifecycle");
    },
  };
}

function createEditTool(workspaceRoot, mutationOptions) {
  return {
    name: "edit",
    description: codingToolEntries.edit.description,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    governance: { ...codingToolEntries.edit.governance, rootDirectory: workspaceRoot },
    async prepare(input, context) {
      context?.signal?.throwIfAborted();
      return prepareFileMutation(workspaceRoot, mutationOptions.mutationSecret, "edit", input);
    },
    async commit(preparation, context) {
      return commitFileMutation(workspaceRoot, mutationOptions, preparation, context?.signal);
    },
    async execute() {
      throw new Error("edit requires the prepare/commit lifecycle");
    },
  };
}

function createCommandTool(workspaceRoot) {
  return {
    name: "command",
    description: codingToolEntries.command.description,
    inputSchema: {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string" }, minItems: 1 },
        cwd: { type: "string" },
        env: { type: "object" },
        timeoutMs: { type: "number" },
        maxOutputBytes: { type: "number" },
      },
      required: ["argv"],
    },
    governance: codingToolEntries.command.governance,
    async execute(input, context) {
      context?.signal?.throwIfAborted();
      const argv = normalizeArgv(input.argv);
      if (argv.length === 0) {
        throw new Error("command requires argv");
      }
      const cwdInput = input.cwd ?? ".";
      const cwd = await resolveExistingDirectoryPath(workspaceRoot, cwdInput, "command cwd");
      const env = normalizeCommandEnv(input.env);
      const timeoutMs = clampInteger(input.timeoutMs, 1, 300000, 30000);
      const maxOutputBytes = clampInteger(input.maxOutputBytes, 1, 50 * 1024 * 1024, 1024 * 1024);
      return await runCommand(argv, cwd, env, context?.signal, timeoutMs, maxOutputBytes, workspaceRoot);
    },
  };
}

async function resolveWorkspaceRoot(root) {
  try {
    return await realpath(root);
  } catch {
    return root;
  }
}

async function resolveReadablePath(workspaceRoot, inputPath, label) {
  const candidate = resolveWorkspacePath(workspaceRoot, inputPath, label);
  const target = await realpath(candidate);
  assertPathInsideRoot(workspaceRoot, target, label);
  const targetStat = await stat(target);
  if (!targetStat.isFile()) {
    throw new Error(`Path is not a file: ${toWorkspaceRelative(workspaceRoot, target)}`);
  }
  return target;
}

async function resolveExistingDirectoryPath(workspaceRoot, inputPath, label) {
  const candidate = resolveWorkspacePath(workspaceRoot, inputPath, label);
  const target = await realpath(candidate);
  assertPathInsideRoot(workspaceRoot, target, label);
  const targetStat = await stat(target);
  if (!targetStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${toWorkspaceRelative(workspaceRoot, target)}`);
  }
  return target;
}

async function resolveWritablePath(workspaceRoot, inputPath, label) {
  const candidate = resolveWorkspacePath(workspaceRoot, inputPath, label);
  const parent = dirname(candidate);
  const safeAncestor = await resolveNearestExistingAncestor(parent);
  const ancestorReal = await realpath(safeAncestor);
  assertPathInsideRoot(workspaceRoot, ancestorReal, label);
  const existing = await readExistingText(candidate);
  if (existing !== undefined) {
    const targetReal = await realpath(candidate);
    assertPathInsideRoot(workspaceRoot, targetReal, label);
  }
  return candidate;
}

function resolveWorkspacePath(workspaceRoot, inputPath, label) {
  const normalized = sanitizeLocalPath(inputPath, label);
  const candidate = isAbsolute(normalized) ? resolve(normalized) : resolve(workspaceRoot, normalized);
  assertPathInsideRoot(workspaceRoot, candidate, label);
  return candidate;
}

async function resolveNearestExistingAncestor(targetPath) {
  let current = targetPath;
  while (true) {
    try {
      await access(current);
      return current;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

function sanitizeLocalPath(value, label) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${label} cannot be empty`);
  }
  if (text.includes("\0") || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`${label} cannot contain control characters`);
  }
  if (text.startsWith("\\\\") || text.startsWith("//")) {
    throw new Error(`${label} must not reference a network path`);
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(text) && !/^[a-zA-Z]:[\\/]/u.test(text)) {
    throw new Error(`${label} must be a local filesystem path`);
  }
  const segments = text.split(/[\\/]+/u);
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${label} must not contain path traversal segments`);
  }
  return text;
}

function assertPathInsideRoot(root, target, label) {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`${label} resolves outside the workspace`);
  }
}

function toWorkspaceRelative(workspaceRoot, path) {
  const relativePath = relative(workspaceRoot, path);
  return relativePath.length > 0 ? relativePath : ".";
}

async function listDirectoryEntries(workspaceRoot, rootPath, recursive) {
  const entries = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const listing = await readdir(current, { withFileTypes: true });
    listing.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of listing) {
      const absolute = join(current, entry.name);
      const relativePath = toWorkspaceRelative(workspaceRoot, absolute);
      const type = entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : "file";
      const stats = entry.isSymbolicLink() ? undefined : await stat(absolute);
      entries.push({
        name: entry.name,
        path: relativePath,
        type,
        ...(stats?.isFile() ? { bytes: stats.size } : {}),
      });
      if (recursive && entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(absolute);
      }
    }
  }
  return entries;
}

async function* walkWorkspaceFiles(workspaceRoot, startPath, recursive, signal) {
  const stack = [startPath];
  while (stack.length > 0) {
    signal?.throwIfAborted();
    const current = stack.pop();
    const listing = await readdir(current, { withFileTypes: true });
    listing.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of listing) {
      signal?.throwIfAborted();
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (recursive) {
          stack.push(absolute);
        }
        continue;
      }
      if (entry.isFile()) {
        yield { absolute, relative: toWorkspaceRelative(workspaceRoot, absolute) };
      }
    }
  }
}

async function readUtf8IfSmallEnough(path) {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size > 1024 * 1024) {
    return undefined;
  }
  return await readFile(path, "utf8");
}

async function readExistingText(path) {
  try {
    const content = await readFile(path, "utf8");
    return content;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function prepareFileMutation(workspaceRoot, secret, operation, input) {
  const currentRoot = await realpath(workspaceRoot).catch(() => {
    throw stalePreparation("workspace is unavailable");
  });
  if (normalizeComparablePath(currentRoot) !== normalizeComparablePath(workspaceRoot)) {
    throw stalePreparation("workspace realpath changed");
  }
  const requestedPath = sanitizeLocalPath(input.path, `${operation} path`);
  const target = await resolveWritablePath(currentRoot, requestedPath, `${operation} path`);
  const targetLstat = await lstat(target).catch((error) => isMissingFileError(error) ? undefined : Promise.reject(error));
  if (targetLstat?.isSymbolicLink()) {
    throw new Error(`${operation} path must not be a symbolic link`);
  }
  const before = await readExistingText(target);
  if (operation === "write" && before !== undefined && input.overwrite !== true) {
    throw new Error(`File already exists: ${toWorkspaceRelative(currentRoot, target)}`);
  }
  if (operation === "edit" && before === undefined) {
    throw new Error(`File does not exist: ${toWorkspaceRelative(currentRoot, target)}`);
  }
  const after = String(input.content ?? "");
  const targetStats = before === undefined ? undefined : await stat(target);
  const targetRealPath = before === undefined ? undefined : await realpath(target);
  const parentPath = dirname(target);
  const ancestor = await resolveNearestExistingAncestor(parentPath);
  const ancestorRealPath = await realpath(ancestor);
  assertPathInsideRoot(currentRoot, ancestorRealPath, `${operation} path`);

  const baselineHash = before === undefined ? "missing" : hashText(before);
  const targetHash = hashText(after);
  const bindingWithoutFingerprint = {
    protocolVersion: MUTATION_PROTOCOL,
    operation,
    workspaceRoot: normalizeComparablePath(currentRoot),
    requestedPath,
    normalizedPath: normalizeComparablePath(target),
    baselineHash,
    baselineExists: before !== undefined,
    baselineMode: targetStats ? targetStats.mode & 0o777 : null,
    targetHash,
  };
  const changeFingerprint = signMutation(secret, bindingWithoutFingerprint);
  const diff = buildDiffPreview(currentRoot, target, operation, before, after, baselineHash, targetHash);
  const binding = Object.freeze({ ...bindingWithoutFingerprint, changeFingerprint });
  const summary = Object.freeze({
    operation,
    path: toWorkspaceRelative(currentRoot, target),
    diffRef: diff.diffRef,
    beforeBytes: Buffer.byteLength(before ?? "", "utf8"),
    afterBytes: Buffer.byteLength(after, "utf8"),
    additions: diff.additions,
    deletions: diff.deletions,
  });
  return Object.freeze({
    protocol: MUTATION_PROTOCOL,
    binding,
    summary,
    presentation: Object.freeze({
      id: `mutation:${changeFingerprint}`,
      kind: "diff",
      revision: 1,
      source: "mingxu-coding-tools",
      sensitivity: "internal",
      state: "complete",
      payload: Object.freeze({
        operation,
        path: summary.path,
        diffRef: diff.diffRef,
        changes: Object.freeze(diff.changes),
        truncated: diff.truncated,
      }),
    }),
    opaque: Object.freeze({
      target,
      parentPath,
      ancestorRealPath: normalizeComparablePath(ancestorRealPath),
      ...(targetRealPath !== undefined ? { targetRealPath: normalizeComparablePath(targetRealPath) } : {}),
      after,
    }),
  });
}

async function commitFileMutation(workspaceRoot, options, preparation, signal) {
  signal?.throwIfAborted();
  const validated = await validatePreparedMutation(workspaceRoot, options.mutationSecret, preparation, false);
  const missingDirectories = await collectMissingDirectories(validated.parentPath, workspaceRoot);
  const createdDirectories = [];
  let committed = false;
  const tempPath = join(validated.parentPath, `.${basename(validated.target)}.mingxu-${process.pid}-${randomUUID()}.tmp`);
  try {
    for (const directory of missingDirectories) {
      try {
        await mkdir(directory);
        createdDirectories.push(directory);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
    }
    await writeFile(tempPath, validated.after, {
      encoding: "utf8",
      flag: "wx",
      mode: preparation.binding.baselineMode ?? 0o666,
      ...(signal ? { signal } : {}),
    });
    if (preparation.binding.baselineMode !== null) {
      await chmod(tempPath, preparation.binding.baselineMode);
    }
    signal?.throwIfAborted();
    await validatePreparedMutation(workspaceRoot, options.mutationSecret, preparation, true);
    await options.atomicReplace(tempPath, validated.target);
    committed = true;
    return {
      kind: "diff",
      operation: preparation.summary.operation,
      path: preparation.summary.path,
      diffRef: preparation.summary.diffRef,
      changeFingerprint: preparation.binding.changeFingerprint,
      summary: preparation.summary,
      committed: true,
    };
  } finally {
    if (!committed) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      for (const directory of [...createdDirectories].reverse()) {
        await rmdir(directory).catch(() => undefined);
      }
    }
  }
}

async function validatePreparedMutation(workspaceRoot, secret, preparation, allowCreatedParent) {
  if (!preparation || preparation.protocol !== MUTATION_PROTOCOL || !preparation.binding || !preparation.summary) {
    throw stalePreparation("invalid mutation preparation");
  }
  const binding = preparation.binding;
  const opaque = preparation.opaque;
  if (!opaque || typeof opaque !== "object" || typeof opaque.target !== "string"
    || typeof opaque.parentPath !== "string" || typeof opaque.ancestorRealPath !== "string" || typeof opaque.after !== "string") {
    throw stalePreparation("invalid opaque mutation state");
  }
  const { changeFingerprint, ...unsignedBinding } = binding;
  const expectedFingerprint = signMutation(secret, unsignedBinding);
  if (!safeEqual(changeFingerprint, expectedFingerprint)) {
    throw stalePreparation("change fingerprint is invalid");
  }
  const currentRoot = await realpath(workspaceRoot).catch(() => {
    throw stalePreparation("workspace moved or is unavailable");
  });
  if (normalizeComparablePath(currentRoot) !== binding.workspaceRoot) {
    throw stalePreparation("workspace realpath changed");
  }
  const target = resolveWorkspacePath(currentRoot, binding.requestedPath, `${binding.operation} path`);
  if (normalizeComparablePath(target) !== binding.normalizedPath || normalizeComparablePath(target) !== normalizeComparablePath(opaque.target)) {
    throw stalePreparation("normalized target changed");
  }
  const targetLstat = await lstat(target).catch((error) => isMissingFileError(error) ? undefined : Promise.reject(error));
  if (targetLstat?.isSymbolicLink()) {
    throw stalePreparation("target was replaced by a symbolic link");
  }
  const before = await readExistingText(target);
  const baselineExists = before !== undefined;
  const baselineHash = baselineExists ? hashText(before) : "missing";
  if (baselineExists !== binding.baselineExists || baselineHash !== binding.baselineHash) {
    throw stalePreparation("file content changed after preview");
  }
  if (baselineExists) {
    const currentStats = await stat(target);
    if ((currentStats.mode & 0o777) !== binding.baselineMode) {
      throw stalePreparation("file permissions changed after preview");
    }
    const targetRealPath = normalizeComparablePath(await realpath(target));
    if (targetRealPath !== opaque.targetRealPath || targetRealPath !== binding.normalizedPath) {
      throw stalePreparation("target realpath changed after preview");
    }
  }
  if (hashText(opaque.after) !== binding.targetHash) {
    throw stalePreparation("target content hash changed");
  }
  const ancestor = await resolveNearestExistingAncestor(opaque.parentPath);
  const ancestorRealPath = normalizeComparablePath(await realpath(ancestor));
  assertPathInsideRoot(currentRoot, ancestorRealPath, `${binding.operation} path`);
  if (!allowCreatedParent && ancestorRealPath !== opaque.ancestorRealPath) {
    throw stalePreparation("parent realpath changed after preview");
  }
  if (allowCreatedParent) {
    const parentRealPath = normalizeComparablePath(await realpath(opaque.parentPath));
    if (parentRealPath !== normalizeComparablePath(opaque.parentPath)) {
      throw stalePreparation("parent directory became a symbolic link");
    }
    assertPathInsideRoot(currentRoot, parentRealPath, `${binding.operation} path`);
  }
  return { target, parentPath: opaque.parentPath, after: opaque.after };
}

function buildDiffPreview(workspaceRoot, target, operation, before, after, baselineHash, targetHash) {
  const beforeText = before ?? "";
  const afterText = String(after ?? "");
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  const allLines = [
    `diff -- ${toWorkspaceRelative(workspaceRoot, target)}`,
    `--- before`,
    `+++ after`,
  ];
  const maxLines = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < maxLines; index += 1) {
    const left = beforeLines[index];
    const right = afterLines[index];
    if (left === right) {
      if (left !== undefined) {
        allLines.push(`  ${left}`);
      }
      continue;
    }
    if (left !== undefined) {
      allLines.push(`- ${left}`);
    }
    if (right !== undefined) {
      allLines.push(`+ ${right}`);
    }
  }
  const changes = [];
  let bytes = 0;
  for (const line of allLines) {
    if (changes.length >= MAX_DIFF_LINES) break;
    const remaining = MAX_DIFF_BYTES - bytes;
    if (remaining <= 0) break;
    const encoded = Buffer.from(line, "utf8");
    const next = encoded.byteLength <= remaining ? line : encoded.subarray(0, remaining).toString("utf8");
    changes.push(next);
    bytes += Buffer.byteLength(next, "utf8") + 1;
  }
  return {
    diffRef: hashText(JSON.stringify({ operation, path: toWorkspaceRelative(workspaceRoot, target), baselineHash, targetHash })),
    additions: allLines.filter((line) => line.startsWith("+ ")).length,
    deletions: allLines.filter((line) => line.startsWith("- ")).length,
    changes,
    truncated: changes.length < allLines.length,
  };
}

function signMutation(secret, binding) {
  return createHmac("sha256", secret).update(JSON.stringify(binding)).digest("hex");
}

function hashText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeComparablePath(value) {
  const normalized = resolve(value).replace(/\\/gu, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function collectMissingDirectories(parentPath, workspaceRoot) {
  const missing = [];
  let current = parentPath;
  while (normalizeComparablePath(current) !== normalizeComparablePath(workspaceRoot)) {
    try {
      await access(current);
      break;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw new Error("Unable to resolve writable parent directory");
      current = parent;
    }
  }
  return missing.reverse();
}

function stalePreparation(reason) {
  return new Error(`Prepared change is stale (${reason}); re-run prepare before writing`);
}

function isAlreadyExistsError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function splitLines(text) {
  return String(text ?? "").split(/\r?\n/u);
}

function clampInteger(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeArgv(argv) {
  if (!Array.isArray(argv)) {
    throw new Error("command requires argv to be an array");
  }
  const normalized = argv.map((value) => String(value));
  if (normalized.length === 0) {
    throw new Error("command requires argv");
  }
  return normalized;
}

function normalizeCommandEnv(envInput) {
  const allowedKeys = new Set(["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "SystemRoot", "ComSpec", "LANG", "LC_ALL", "TERM"]);
  const env = {};
  for (const key of allowedKeys) {
    if (typeof process.env[key] === "string") {
      env[key] = process.env[key];
    }
  }
  if (envInput === undefined) {
    return env;
  }
  if (!envInput || typeof envInput !== "object" || Array.isArray(envInput)) {
    throw new Error("command env must be an object");
  }
  for (const [key, value] of Object.entries(envInput)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`command env key is not allowed: ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`command env value must be a string: ${key}`);
    }
    env[key] = value;
  }
  return env;
}

async function runCommand(argv, cwd, env, signal, timeoutMs, maxOutputBytes, workspaceRoot) {
  const startedAt = Date.now();
  const [command, ...args] = argv;
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    const finish = (result) => {
      resolve(result);
    };
    const fail = (error) => {
      reject(error);
    };
    const append = (current, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxOutputBytes - totalBytes;
      if (remaining <= 0) {
        truncated = true;
        return current;
      }
      const slice = buffer.subarray(0, remaining);
      totalBytes += slice.byteLength;
      if (slice.byteLength < buffer.byteLength) {
        truncated = true;
      }
      return current + slice.toString("utf8");
    };
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
      if (truncated) {
        child.kill();
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
      if (truncated) {
        child.kill();
      }
    });
    const timeoutHandle = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : undefined;
    child.once("error", (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      fail(error);
    });
    child.once("close", (exitCode, signalName) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const normalizedExitCode = exitCode ?? (timedOut ? 124 : truncated ? 137 : signalName !== null ? 1 : 0);
      finish({
        kind: "command",
        argv,
        cwd: toWorkspaceRelative(workspaceRoot, cwd),
        exitCode: normalizedExitCode,
        ...(signalName !== null ? { signal: signalName } : {}),
        stdout,
        stderr,
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function isMissingFileError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
