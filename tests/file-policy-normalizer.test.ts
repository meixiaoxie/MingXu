import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeFileAccess } from "../src/policy/normalizers/file-access-normalizer.js";

describe("file access normalizer", () => {
  it("normalizes an allowed path inside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-policy-file-"));
    const target = join(root, "note.txt");
    await writeFile(target, "hello", "utf8");
    const canonicalTarget = await realpath(target);

    try {
      const request = await normalizeFileAccess({
        toolName: "readFile",
        rootDirectory: root,
        path: "note.txt",
        mode: "read",
        principalId: "local-user",
        interactive: false,
        runId: "run-1",
        iteration: 1,
      });

      expect(request.action).toMatchObject({ kind: "file.read", name: "readFile", mode: "read" });
      expect(request.resource.kind).toBe("file");
      if (request.resource.kind !== "file") {
        throw new Error("Expected a file resource");
      }
      expect(request.resource.resolvedPath).toBe(target);
      expect(request.resource.caseNormalizedPath).toBe(canonicalTarget.replace(/\\/gu, "/").toLowerCase());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal outside the allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-policy-file-"));

    try {
      await expect(normalizeFileAccess({
        toolName: "readFile",
        rootDirectory: root,
        path: "../outside.txt",
        mode: "read",
        principalId: "local-user",
        interactive: false,
        runId: "run-1",
        iteration: 1,
      })).rejects.toThrow("outside the allowed root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlink escape when the platform permits symlink creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-policy-file-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mingxu-policy-outside-"));
    const outsideFile = join(outsideRoot, "secret.txt");
    await writeFile(outsideFile, "secret", "utf8");
    const linksDir = join(root, "links");
    await mkdir(linksDir, { recursive: true });
    const linkPath = join(linksDir, "outside-link.txt");

    try {
      try {
        await symlink(await realpath(outsideFile), linkPath);
      } catch (error) {
        if (error instanceof Error && /EPERM|privilege|not permitted/i.test(error.message)) {
          return;
        }
        throw error;
      }

      await expect(normalizeFileAccess({
        toolName: "readFile",
        rootDirectory: root,
        path: "links/outside-link.txt",
        mode: "read",
        principalId: "local-user",
        interactive: false,
        runId: "run-1",
        iteration: 1,
      })).rejects.toThrow("outside the allowed root");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
