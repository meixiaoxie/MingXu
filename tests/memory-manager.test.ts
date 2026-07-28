import { describe, expect, it, afterEach } from "vitest";
import { FileMemoryStore } from "../src/index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
});
