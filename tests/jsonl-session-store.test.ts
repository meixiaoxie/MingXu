import { describe, expect, it, afterEach } from "vitest";
import { JsonlSessionStore } from "../src/index.js";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

describe("JSONL session store", () => {
  const testPath = join(tmpdir(), `mingxu-test-session-${Date.now()}.jsonl`);

  afterEach(async () => {
    await rm(testPath, { force: true });
  });

  it("追加后可加载指定 sessionId 的 entries", async () => {
    const store = new JsonlSessionStore(testPath);
    await store.append({
      id: "e1",
      type: "message",
      sessionId: "s1",
      createdAt: "now",
      message: {
        id: "m1",
        role: "user",
        content: "hi",
        createdAt: "now",
      },
    });

    const entries = await store.load("s1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe("e1");
  });

  it("不加载其他 sessionId 的 entries", async () => {
    const store = new JsonlSessionStore(testPath);
    await store.append({
      id: "e1",
      type: "message",
      sessionId: "s1",
      createdAt: "now",
      message: {
        id: "m1",
        role: "user",
        content: "hi",
        createdAt: "now",
      },
    });
    await store.append({
      id: "e2",
      type: "message",
      sessionId: "s2",
      createdAt: "now",
      message: {
        id: "m2",
        role: "user",
        content: "hey",
        createdAt: "now",
      },
    });

    expect(await store.load("s1")).toHaveLength(1);
    expect(await store.load("s2")).toHaveLength(1);
  });

  it("损坏行被跳过", async () => {
    const store = new JsonlSessionStore(testPath);
    // 手动写坏行
    await mkdir(dirname(testPath), { recursive: true });
    await writeFile(testPath, "not json\n", "utf8");
    await store.append({
      id: "e1",
      type: "message",
      sessionId: "s1",
      createdAt: "now",
      message: {
        id: "m1",
        role: "user",
        content: "hi",
        createdAt: "now",
      },
    });

    const entries = await store.load("s1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe("e1");
  });

  it("支持 parent chain 查找", async () => {
    const store = new JsonlSessionStore(testPath);
    await store.append({
      id: "root",
      type: "message",
      sessionId: "s1",
      createdAt: "1",
      message: {
        id: "m1",
        role: "user",
        content: "root",
        createdAt: "1",
      },
    });
    await store.append({
      id: "child",
      type: "message",
      sessionId: "s1",
      parentId: "root",
      createdAt: "2",
      message: {
        id: "m2",
        role: "assistant",
        content: "child",
        createdAt: "2",
      },
    });
    await store.append({
      id: "grandchild",
      type: "message",
      sessionId: "s1",
      parentId: "child",
      createdAt: "3",
      message: {
        id: "m3",
        role: "user",
        content: "gc",
        createdAt: "3",
      },
    });

    const chain = await store.getAncestorChain("grandchild");
    expect(chain).toHaveLength(3);
    expect(chain.map((e) => e.id)).toEqual(["root", "child", "grandchild"]);
  });

  it("能找到最新叶子", async () => {
    const store = new JsonlSessionStore(testPath);
    await store.append({
      id: "e1",
      type: "message",
      sessionId: "s1",
      createdAt: "2026-01-01",
      message: {
        id: "m1",
        role: "user",
        content: "a",
        createdAt: "now",
      },
    });
    await store.append({
      id: "e2",
      type: "message",
      sessionId: "s1",
      parentId: "e1",
      createdAt: "2026-01-02",
      message: {
        id: "m2",
        role: "assistant",
        content: "b",
        createdAt: "now",
      },
    });

    const leaf = await store.getLatestLeaf("s1");
    expect(leaf?.id).toBe("e2");
  });
});
