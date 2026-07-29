import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const INVALID_STORAGE_KEY_CHARACTERS = /[\u0000-\u001f\u007f\\/:]/u;

export function assertSafeStorageKey(value: string, label: string): void {
  if (!value || value.length > 128) {
    throw new Error(`${label} must contain between 1 and 128 characters`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} cannot have surrounding whitespace`);
  }
  if (value === "." || value === ".." || value.endsWith(".") || value.endsWith(" ")) {
    throw new Error(`${label} is not a safe storage key: ${value}`);
  }
  if (INVALID_STORAGE_KEY_CHARACTERS.test(value) || WINDOWS_RESERVED_NAMES.test(value)) {
    throw new Error(`${label} is not a safe storage key: ${value}`);
  }
}

export function resolveSafeStoragePath(
  rootDirectory: string,
  key: string,
  extension: string,
  label: string,
): string {
  assertSafeStorageKey(key, label);
  const root = resolve(rootDirectory);
  const target = resolve(root, `${key}${extension}`);
  assertPathInsideRoot(root, target, label);
  return target;
}

export async function assertSafeStorageTarget(rootDirectory: string, targetPath: string): Promise<void> {
  const realRoot = await realpath(resolve(rootDirectory));
  let targetStats;
  try {
    targetStats = await lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      assertPathInsideRoot(realRoot, resolve(realRoot, relative(resolve(rootDirectory), targetPath)), "Storage target");
      return;
    }
    throw error;
  }

  if (targetStats.isSymbolicLink()) {
    throw new Error(`Storage target cannot be a symbolic link: ${targetPath}`);
  }
  assertPathInsideRoot(realRoot, await realpath(targetPath), "Storage target");
}

function assertPathInsideRoot(root: string, target: string, label: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`${label} resolves outside the configured storage root`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
