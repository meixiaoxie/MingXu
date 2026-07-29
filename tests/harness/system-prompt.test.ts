import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../../src/harness/system-prompt.js";

describe("system prompt harness", () => {
  it("keeps the base prompt when no project root is provided", async () => {
    await expect(buildSystemPrompt({ baseSystemPrompt: "base prompt" })).resolves.toBe("base prompt");
  });

  it("loads MINGXU.md after the base prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-system-prompt-"));
    try {
      await writeFile(join(root, "MINGXU.md"), "project rules", "utf8");
      await expect(buildSystemPrompt({
        baseSystemPrompt: "base prompt",
        projectRoot: root,
      })).resolves.toBe("base prompt\n\n---\n\nproject rules");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers MINGXU.md over CLAUDE.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-system-prompt-prefer-"));
    try {
      await writeFile(join(root, "MINGXU.md"), "project rules", "utf8");
      await writeFile(join(root, "CLAUDE.md"), "old project rules", "utf8");
      await expect(buildSystemPrompt({
        baseSystemPrompt: "base prompt",
        projectRoot: root,
      })).resolves.toBe("base prompt\n\n---\n\nproject rules");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a missing project instruction file", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-system-prompt-missing-"));
    try {
      await expect(buildSystemPrompt({
        baseSystemPrompt: "base prompt",
        projectRoot: root,
      })).resolves.toBe("base prompt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
