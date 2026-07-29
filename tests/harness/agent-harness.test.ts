import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentHarness } from "../../src/harness/agent-harness.js";

function createProvider() {
  const seen: { systemPrompt?: string; messages: unknown[] } = { messages: [] };

  return {
    seen,
    async generate(input: any) {
      seen.systemPrompt = input.systemPrompt;
      seen.messages = input.messages ?? [];
      return {
        content: input.systemPrompt ?? "",
        toolCalls: [],
      };
    },
  };
}

describe("AgentHarness", () => {
  it("injects MINGXU.md into the system prompt for project roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-agent-harness-"));
    try {
      await writeFile(join(root, "MINGXU.md"), "project rules", "utf8");
      const provider = createProvider();
      const harness = new AgentHarness({
        model: provider,
        modelKey: "test-model",
        projectRoot: root,
        systemPrompt: "base prompt",
      });

      const result = await harness.prompt("hello");
      expect(result.content).toContain("base prompt");
      expect(result.content).toContain("project rules");
      expect(provider.seen.systemPrompt).toContain("project rules");
      expect(provider.seen.messages.some((message) => JSON.stringify(message).includes("project rules"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips MINGXU.md injection when autoLoadClaudeMd is false", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-agent-harness-skip-"));
    try {
      await writeFile(join(root, "MINGXU.md"), "project rules", "utf8");
      const provider = createProvider();
      const harness = new AgentHarness({
        model: provider,
        modelKey: "test-model",
        projectRoot: root,
        systemPrompt: "base prompt",
        autoLoadClaudeMd: false,
      });

      const result = await harness.prompt("hello");
      expect(result.content).toBe("base prompt");
      expect(provider.seen.systemPrompt).toBe("base prompt");
      expect(provider.seen.messages.some((message) => JSON.stringify(message).includes("project rules"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the session store wiring intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-agent-harness-session-"));
    try {
      const harness = new AgentHarness({
        model: createProvider(),
        modelKey: "test-model",
        sessionFilePath: join(root, "sessions"),
      });

      expect(harness.sessionStore).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
