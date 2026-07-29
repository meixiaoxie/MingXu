import { describe, expect, it, afterEach } from "vitest";
import { FileMemoryStore } from "../src/memory/file-memory-store.js";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("file memory store", () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) await rm(testDir, { recursive: true, force: true });
  });

  it("加载 scope 目录下的 .md 文件", async () => {
    testDir = await mkdtemp(join(tmpdir(), "mingxu-memory-"));
    await writeFile(
      join(testDir, "test-memory.md"),
      "This is a test memory",
      "utf8",
    );

    const store = new FileMemoryStore();
    store.addScope("project", testDir);

    const results = await store.query({ scope: "project" });
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("test-memory");
    expect(results[0]!.content).toBe("This is a test memory");
  });

  it("会跳过项目说明文件，不把它们当成长期记忆", async () => {
    testDir = await mkdtemp(join(tmpdir(), "mingxu-memory-instructions-"));
    await writeFile(join(testDir, "MINGXU.md"), "project instructions", "utf8");
    await writeFile(join(testDir, "note.md"), "content a", "utf8");

    const store = new FileMemoryStore();
    store.addScope("project", testDir);

    const results = await store.query({ scope: "project" });
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("note");
    expect(results[0]!.content).toBe("content a");
  });

  it("按 key 过滤", async () => {
    testDir = await mkdtemp(join(tmpdir(), "mingxu-memory-"));
    await writeFile(join(testDir, "a.md"), "content a", "utf8");
    await writeFile(join(testDir, "b.md"), "content b", "utf8");

    const store = new FileMemoryStore();
    store.addScope("project", testDir);

    const results = await store.query({ scope: "project", key: "a" });
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("a");
  });

  it("不存在的 scope 返回空", async () => {
    const store = new FileMemoryStore();
    const results = await store.query({ scope: "user" });
    expect(results).toEqual([]);
  });

  it("rejects memory keys that escape the configured scope", async () => {
    testDir = await mkdtemp(join(tmpdir(), "mingxu-memory-safe-"));
    const memoryRoot = join(testDir, "memory");
    const store = new FileMemoryStore({ project: memoryRoot });

    await expect(store.save({ scope: "project", key: "../escaped", content: "no" })).rejects.toThrow(
      "Memory key is not a safe storage key",
    );
    await expect(access(join(testDir, "escaped.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects reserved names and symbolic-link write targets", async () => {
    testDir = await mkdtemp(join(tmpdir(), "mingxu-memory-target-safe-"));
    const memoryRoot = join(testDir, "memory");
    const outside = join(testDir, "outside");
    const sentinel = join(outside, "sentinel.md");
    const store = new FileMemoryStore({ project: memoryRoot });
    await mkdir(outside);
    await writeFile(sentinel, "sentinel", "utf8");

    await expect(store.save({ scope: "project", key: "CON", content: "no" })).rejects.toThrow(
      "Memory key is not a safe storage key",
    );
    await store.save({ scope: "project", key: "placeholder", content: "created" });
    await rm(join(memoryRoot, "placeholder.md"));
    await symlink(outside, join(memoryRoot, "placeholder.md"), process.platform === "win32" ? "junction" : "dir");
    await expect(store.save({ scope: "project", key: "placeholder", content: "overwrite" })).rejects.toThrow(
      "Storage target cannot be a symbolic link",
    );
    expect(await readFile(sentinel, "utf8")).toBe("sentinel");
  });
});
