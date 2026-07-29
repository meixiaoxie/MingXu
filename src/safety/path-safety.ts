import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const INVALID_IDENTIFIER_CHARACTERS = /[\u0000-\u001f\u007f\\/:]/u;

export function assertSafeIdentifier(value: string, label: string): void {
  if (!value || value.length > 128) {
    throw new Error(`${label} must contain between 1 and 128 characters`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} cannot have surrounding whitespace`);
  }
  if (value === "." || value === ".." || value.endsWith(".") || value.endsWith(" ")) {
    throw new Error(`${label} is not a safe identifier: ${value}`);
  }
  if (INVALID_IDENTIFIER_CHARACTERS.test(value) || WINDOWS_RESERVED_NAMES.test(value)) {
    throw new Error(`${label} is not a safe identifier: ${value}`);
  }
}

export function assertSafeLocalPath(value: string, label: string): string {
  if (!value || value !== value.trim()) {
    throw new Error(`${label} cannot be empty`);
  }
  if (value.includes("\0") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} cannot contain control characters`);
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(value) && !/^[a-zA-Z]:[\\/]/u.test(value)) {
    throw new Error(`${label} must be a local filesystem path`);
  }
  if (value.startsWith("\\\\") || value.startsWith("//")) {
    throw new Error(`${label} must not reference a network path`);
  }
  if (/^(?:\.|\.{2})(?:[\\/]|$)/u.test(value) || value.includes(`${sep}..${sep}`) || value.endsWith(`${sep}..`)) {
    throw new Error(`${label} must not contain path traversal segments`);
  }
  return resolve(value);
}

export async function assertPathInsideRoot(rootDirectory: string, targetPath: string, label: string): Promise<void> {
  const resolvedRoot = await realpath(resolve(rootDirectory));
  let targetRealPath: string;
  try {
    const targetStats = await lstat(targetPath);
    if (targetStats.isSymbolicLink()) {
      throw new Error(`${label} cannot be a symbolic link: ${targetPath}`);
    }
    targetRealPath = await realpath(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      const resolvedTarget = resolve(targetPath);
      assertRelativePathInsideRoot(resolvedRoot, resolvedTarget, label);
      return;
    }
    throw error;
  }
  assertRelativePathInsideRoot(resolvedRoot, targetRealPath, label);
}

export function resolveSafeRelativePath(rootDirectory: string, relativePath: string): string {
  if (!relativePath || relativePath !== relativePath.trim()) {
    throw new Error("Relative path cannot be empty");
  }
  if (relativePath.includes("\0") || /[\u0000-\u001f\u007f]/u.test(relativePath)) {
    throw new Error("Relative path cannot contain control characters");
  }
  if (relativePath.startsWith("\\\\") || relativePath.startsWith("//")) {
    throw new Error("Relative path cannot reference a network location");
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(relativePath) && !/^[a-zA-Z]:[\\/]/u.test(relativePath)) {
    throw new Error("Relative path must be local");
  }
  if (/^(?:\.|\.{2})(?:[\\/]|$)/u.test(relativePath)) {
    throw new Error("Relative path cannot contain path traversal segments");
  }
  return resolve(rootDirectory, relativePath);
}

export function normalizeFileUrlPath(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "file:"
    || (url.hostname !== "" && url.hostname !== "localhost")
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== "") {
    throw new Error("Only local file URLs are supported");
  }
  return fileURLToPath(url);
}

function assertRelativePathInsideRoot(root: string, target: string, label: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`${label} resolves outside the configured root`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
