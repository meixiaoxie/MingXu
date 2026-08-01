import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PreparedToolMutation } from "@mingxu/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodingToolsPlugin } from "../packages/coding-tools/runtime.js";

interface MutationTool {
  prepare(input: unknown, context?: { signal?: AbortSignal }): Promise<PreparedToolMutation>;
  commit(preparation: PreparedToolMutation, context?: { signal?: AbortSignal }): Promise<unknown>;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("R6 coding-tools mutation safety", () => {
  it("rejects content, permission, and fingerprint drift after preview", async () => {
    const root = await workspace();
    const edit = await mutationTool(root, "edit");

    const contentPreparation = await edit.prepare({ path: "existing.txt", content: "target\n" });
    await writeFile(join(root, "existing.txt"), "concurrent\n", "utf8");
    await expect(edit.commit(contentPreparation)).rejects.toThrow("file content changed after preview");
    await expect(readFile(join(root, "existing.txt"), "utf8")).resolves.toBe("concurrent\n");

    await writeFile(join(root, "existing.txt"), "baseline\n", "utf8");
    await chmod(join(root, "existing.txt"), 0o644);
    const permissionPreparation = await edit.prepare({ path: "existing.txt", content: "target\n" });
    await chmod(join(root, "existing.txt"), 0o444);
    await expect(edit.commit(permissionPreparation)).rejects.toThrow("file permissions changed after preview");
    await chmod(join(root, "existing.txt"), 0o644);

    const valid = await edit.prepare({ path: "existing.txt", content: "target\n" });
    const forged = {
      ...valid,
      binding: { ...valid.binding, targetHash: "forged" },
    } as PreparedToolMutation;
    await expect(edit.commit(forged)).rejects.toThrow("change fingerprint is invalid");
    await expect(readFile(join(root, "existing.txt"), "utf8")).resolves.toBe("baseline\n");
  });

  it("rejects parent symlink replacement and workspace movement", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "mingxu-r6-outside-"));
    roots.push(outside);
    await mkdir(join(root, "parent"));
    const write = await mutationTool(root, "write");
    const symlinkPreparation = await write.prepare({ path: "parent/new.txt", content: "target\n" });
    await rename(join(root, "parent"), join(root, "parent-original"));
    await symlink(outside, join(root, "parent"), process.platform === "win32" ? "junction" : "dir");
    await expect(write.commit(symlinkPreparation)).rejects.toThrow(/outside the workspace|realpath changed|symbolic link/u);
    await expect(readFile(join(outside, "new.txt"), "utf8")).rejects.toThrow();

    const moveRoot = await workspace();
    const moveWrite = await mutationTool(moveRoot, "write");
    const movePreparation = await moveWrite.prepare({ path: "new.txt", content: "target\n" });
    const moved = `${moveRoot}-moved`;
    roots.push(moved);
    await rename(moveRoot, moved);
    await expect(moveWrite.commit(movePreparation)).rejects.toThrow("workspace moved or is unavailable");
    await expect(readFile(join(moved, "new.txt"), "utf8")).rejects.toThrow();
  });

  it("cleans temporary files after atomic failure or Abort and permits a safe retry", async () => {
    const root = await workspace();
    let attempts = 0;
    const atomicReplace = vi.fn(async (temporaryPath: string, targetPath: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error("atomic replace failed");
      await rename(temporaryPath, targetPath);
    });
    const edit = await mutationTool(root, "edit", atomicReplace);
    const preparation = await edit.prepare({ path: "existing.txt", content: "target\n" });

    await expect(edit.commit(preparation)).rejects.toThrow("atomic replace failed");
    await expect(readFile(join(root, "existing.txt"), "utf8")).resolves.toBe("baseline\n");
    expect((await readdir(root)).filter((name) => name.includes(".mingxu-"))).toEqual([]);

    await expect(edit.commit(preparation)).resolves.toMatchObject({ committed: true });
    await expect(readFile(join(root, "existing.txt"), "utf8")).resolves.toBe("target\n");

    const abortRoot = await workspace();
    const controller = new AbortController();
    const abortEdit = await mutationTool(abortRoot, "edit", async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    const abortPreparation = await abortEdit.prepare({ path: "existing.txt", content: "aborted\n" });
    await expect(abortEdit.commit(abortPreparation, { signal: controller.signal })).rejects.toThrow();
    await expect(readFile(join(abortRoot, "existing.txt"), "utf8")).resolves.toBe("baseline\n");
    expect((await readdir(abortRoot)).filter((name) => name.includes(".mingxu-"))).toEqual([]);
  });

  it("preserves the exact existing file mode across atomic replacement", async () => {
    const root = await workspace();
    const target = join(root, "existing.txt");
    await chmod(target, 0o666);
    const edit = await mutationTool(root, "edit");
    const preparation = await edit.prepare({ path: "existing.txt", content: "target\n" });

    await edit.commit(preparation);

    expect((await stat(target)).mode & 0o777).toBe(0o666);
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mingxu-r6-workspace-"));
  roots.push(root);
  await writeFile(join(root, "existing.txt"), "baseline\n", "utf8");
  return root;
}

async function mutationTool(
  root: string,
  name: "write" | "edit",
  atomicReplace?: (temporaryPath: string, targetPath: string) => Promise<void>,
): Promise<MutationTool> {
  let selected: MutationTool | undefined;
  const plugin = createCodingToolsPlugin({ workspaceRoot: root, ...(atomicReplace ? { atomicReplace } : {}) });
  await plugin.setup({
    registerTool(tool) {
      if (tool.name === name) selected = tool as unknown as MutationTool;
    },
  });
  return selected!;
}
