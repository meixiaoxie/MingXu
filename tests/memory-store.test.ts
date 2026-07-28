import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../src/index.js";
import type { MemoryStore } from "../src/index.js";

describe("InMemoryStore", () => {
  it("implements the exported store contract", async () => {
    const store: MemoryStore<string> = new InMemoryStore<string>();

    await store.set("session", "hello");

    await expect(store.get("session")).resolves.toBe("hello");
    await expect(store.keys()).resolves.toEqual(["session"]);
    await expect(store.delete("session")).resolves.toBe(true);
    await expect(store.get("session")).resolves.toBeUndefined();
  });

  it("clears values and rejects empty keys", async () => {
    const store = new InMemoryStore<number>();
    await store.set("one", 1);
    await store.clear();

    await expect(store.keys()).resolves.toEqual([]);
    await expect(store.set(" ", 2)).rejects.toThrow("Memory key cannot be empty");
  });
});
