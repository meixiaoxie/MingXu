import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createReadFileTool,
  defineTool,
  echoTool,
  ToolRegistry,
} from "../src/index.js";

describe("ToolRegistry", () => {
  it("registers, finds, lists, and executes a tool", async () => {
    const registry = new ToolRegistry([echoTool]);

    expect(registry.has("echo")).toBe(true);
    expect(registry.get("echo")).toBe(echoTool);
    expect(registry.list()).toEqual([echoTool]);
    await expect(registry.execute("echo", { message: "hello" })).resolves.toBe("hello");
  });

  it("rejects duplicate, malformed, and unknown tool names", async () => {
    const tool = defineTool({
      name: "sample",
      description: "A minimal test tool.",
      inputSchema: z.object({ value: z.string() }),
      execute: ({ value }) => value,
    });
    const registry = new ToolRegistry([tool]);

    expect(() => registry.register(tool)).toThrow("Tool already registered: sample");
    expect(() => registry.register({ ...tool, name: " sample " })).toThrow(
      "Tool name cannot have surrounding whitespace",
    );
    await expect(registry.execute("missing", {})).rejects.toThrow("Unknown tool: missing");
  });

  it("validates tool input before execution", async () => {
    const registry = new ToolRegistry([echoTool]);

    await expect(registry.execute("echo", { message: 123 })).rejects.toThrow();
    await expect(registry.execute("echo", { message: "ok", extra: true })).resolves.toBe("ok");
  });

  it("prefers an explicitly supplied input over legacy arguments", async () => {
    const valueTool = defineTool({
      name: "value",
      description: "Return any supplied value.",
      inputSchema: z.unknown(),
      execute: (value) => value,
    });
    const registry = new ToolRegistry([valueTool]);

    await expect(registry.execute({ name: "value", input: null, arguments: "fallback" }))
      .resolves.toBeNull();
  });
});

describe("readFile tool", () => {
  it("reads files within the configured root and blocks traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-tools-"));
    await writeFile(join(root, "inside.txt"), "inside", "utf8");
    const tool = createReadFileTool({ rootDirectory: root, maxBytes: 32 });

    await expect(tool.execute({ path: "inside.txt" })).resolves.toBe("inside");
    await expect(tool.execute({ path: "../outside.txt" })).rejects.toThrow(
      "File is outside the allowed root",
    );
  });

  it("rejects invalid size limits", () => {
    expect(() => createReadFileTool({ maxBytes: 0 })).toThrow(
      "readFile maxBytes must be a positive integer",
    );
  });
});
