import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileSessionStore } from "../src/index.js";

describe("FileSessionStore", () => {
  it("persists values to a JSON file and clears them from disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-session-"));
    const filePath = join(root, "nested", "session.json");
    const store = new FileSessionStore<{ count: number }>(filePath);

    try {
      await store.set("alpha", { count: 1 });
      await expect(readFile(filePath, "utf8")).resolves.toBe(
        "{\n  \"alpha\": {\n    \"count\": 1\n  }\n}\n",
      );

      await store.set("beta", { count: 2 });
      await expect(store.get("alpha")).resolves.toEqual({ count: 1 });
      await expect(store.keys()).resolves.toEqual(["alpha", "beta"]);
      await expect(readFile(filePath, "utf8")).resolves.toBe(
        "{\n  \"alpha\": {\n    \"count\": 1\n  },\n  \"beta\": {\n    \"count\": 2\n  }\n}\n",
      );

      await expect(store.delete("missing")).resolves.toBe(false);
      await expect(store.delete("alpha")).resolves.toBe(true);
      await expect(store.keys()).resolves.toEqual(["beta"]);

      await store.clear();
      await expect(store.keys()).resolves.toEqual([]);
      await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid file paths and malformed JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-session-"));
    const filePath = join(root, "session.json");

    try {
      await writeFile(filePath, "not-json", "utf8");

      expect(() => new FileSessionStore(" ")).toThrow("Session file path cannot be empty");
      await expect(new FileSessionStore(filePath).keys()).rejects.toThrow(
        `Failed to read session file: ${filePath}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
