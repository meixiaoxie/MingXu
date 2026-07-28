import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../src/index.js";
import type { MemoryStore } from "../src/index.js";

describe("InMemoryStore", () => {
  it("implements the exported store contract", async () => {
    const store: MemoryStore<number> = new InMemoryStore<number>();

    await store.set("one", 1);
    await store.set("two", 2);

    await expect(store.get("one")).resolves.toBe(1);
    await expect(store.keys()).resolves.toEqual(["one", "two"]);
    await expect(store.delete("missing")).resolves.toBe(false);
    await expect(store.delete("one")).resolves.toBe(true);
    await expect(store.get("one")).resolves.toBeUndefined();
  });

  it("clears values and rejects empty keys", async () => {
    const store = new InMemoryStore<string>();
    await store.set("session", "hello");
    await store.clear();

    await expect(store.keys()).resolves.toEqual([]);
    await expect(store.set(" ", "ignored")).rejects.toThrow("Memory key cannot be empty");
    await expect(store.get("")).rejects.toThrow("Memory key cannot be empty");
    await expect(store.delete("\t")).rejects.toThrow("Memory key cannot be empty");
  });
});
