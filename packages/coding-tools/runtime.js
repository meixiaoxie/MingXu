import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CODING_TOOL_NAMES = ["read", "list", "search", "write", "edit", "command"];

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

  return {
    name: codingToolsManifest.name,
    manifest: codingToolsManifest,
    async setup(context) {
      const root = await resolveWorkspaceRoot(resolvedWorkspaceRoot);
      for (const tool of createWorkspaceTools(root)) {
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

function createWorkspaceTools(workspaceRoot) {
  return [
    createReadTool(workspaceRoot),
    createListTool(workspaceRoot),
    createSearchTool(workspaceRoot),
    createWriteTool(workspaceRoot),
    createEditTool(workspaceRoot),
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
    governance: codingToolEntries.read.governance,
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
    governance: codingToolEntries.list.governance,
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
    governance: codingToolEntries.search.governance,
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

function createWriteTool(workspaceRoot) {
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
    governance: codingToolEntries.write.governance,
    async execute(input, context) {
      context?.signal?.throwIfAborted();
      const target = await resolveWritablePath(workspaceRoot, input.path, "write path");
      const before = await readExistingText(target);
      if (before !== undefined && input.overwrite !== true) {
        throw new Error(`File already exists: ${toWorkspaceRelative(workspaceRoot, target)}`);
      }
      await mkdir(dirname(target), { recursive: true });
      const after = String(input.content ?? "");
      await writeFile(target, after, "utf8");
      return buildDiffResult(workspaceRoot, target, "write", before, after);
    },
  };
}

function createEditTool(workspaceRoot) {
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
    governance: codingToolEntries.edit.governance,
    async execute(input, context) {
      context?.signal?.throwIfAborted();
      const target = await resolveWritablePath(workspaceRoot, input.path, "edit path");
      const before = await readExistingText(target);
      if (before === undefined) {
        throw new Error(`File does not exist: ${toWorkspaceRelative(workspaceRoot, target)}`);
      }
      await mkdir(dirname(target), { recursive: true });
      const after = String(input.content ?? "");
      await writeFile(target, after, "utf8");
      return buildDiffResult(workspaceRoot, target, "edit", before, after);
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

function buildDiffResult(workspaceRoot, target, operation, before, after) {
  const beforeText = before ?? "";
  const afterText = String(after ?? "");
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  const diffLines = [
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
        diffLines.push(`  ${left}`);
      }
      continue;
    }
    if (left !== undefined) {
      diffLines.push(`- ${left}`);
    }
    if (right !== undefined) {
      diffLines.push(`+ ${right}`);
    }
  }
  return {
    kind: "diff",
    operation,
    path: toWorkspaceRelative(workspaceRoot, target),
    before: beforeText,
    after: afterText,
    changes: diffLines,
  };
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
