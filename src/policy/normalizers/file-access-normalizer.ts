import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

import type { PolicyRequest } from "../types.js";

export interface FileAccessNormalizerInput {
  toolName: string;
  rootDirectory: string;
  path: string;
  mode: "read" | "write";
  principalId: string;
  interactive: boolean;
  runId: string;
  iteration: number;
  toolCallId?: string;
  sessionId?: string;
  traceId?: string;
}

export async function normalizeFileAccess(input: FileAccessNormalizerInput): Promise<PolicyRequest> {
  const root = resolve(input.rootDirectory);
  const requestedPath = resolve(root, input.path);
  const realRoot = await realpath(root);
  const realTarget = await realpath(requestedPath).catch(() => requestedPath);
  assertPathInsideRoot(realRoot, realTarget, input.path);

  return {
    principal: {
      kind: "user",
      id: input.principalId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    },
    action: {
      kind: input.mode === "read" ? "file.read" : "file.write",
      name: input.toolName,
      mode: input.mode,
    },
    resource: {
      kind: "file",
      root: realRoot,
      requestedPath: input.path,
      resolvedPath: requestedPath,
      ...(realTarget !== requestedPath ? { realPath: realTarget } : {}),
      caseNormalizedPath: normalizePath(realTarget),
      isUnc: requestedPath.startsWith("\\\\") || requestedPath.startsWith("//"),
    },
    normalizedInput: {
      path: input.path,
      mode: input.mode,
      realPath: realTarget,
    },
    runContext: {
      runId: input.runId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      interactive: input.interactive,
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      iteration: input.iteration,
    },
  };
}

function assertPathInsideRoot(root: string, filePath: string, inputPath: string): void {
  const pathFromRoot = relative(root, filePath);
  if (
    pathFromRoot === ".."
    || pathFromRoot.startsWith(`..${sep}`)
    || isAbsolute(pathFromRoot)
  ) {
    throw new Error(`File is outside the allowed root: ${inputPath}`);
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").toLowerCase();
}
