import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentConfigSchema,
  defineAgentConfig,
  loadConfig,
} from "../src/index.js";

const model = {
  provider: "anthropic",
  model: "claude-sonnet-5",
};

describe("agent config", () => {
  it("accepts the minimal config shape and applies defaults", () => {
    const config = defineAgentConfig({ model });

    expect(config).toMatchObject({
      name: "mingxu",
      model,
      maxIterations: 10,
      plugins: [],
    });
    expect(agentConfigSchema.safeParse(config).success).toBe(true);
  });

  it("rejects missing, unknown, and malformed config values", () => {
    expect(agentConfigSchema.safeParse({}).success).toBe(false);
    expect(agentConfigSchema.safeParse({ model: { provider: "anthropic" } }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ model, unknown: true }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ model: { ...model, unknown: true } }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ model, maxIterations: 0 }).success).toBe(false);
  });

  it("trims identifier-like values without changing the system prompt", () => {
    const config = defineAgentConfig({
      name: "  assistant  ",
      systemPrompt: "  preserve these spaces  ",
      model: { provider: " anthropic ", model: " claude-sonnet-5 " },
      plugins: [" ./plugin.js "],
    });

    expect(config.name).toBe("assistant");
    expect(config.systemPrompt).toBe("  preserve these spaces  ");
    expect(config.model.provider).toBe("anthropic");
    expect(config.plugins).toEqual(["./plugin.js"]);
  });
});

describe("loadConfig", () => {
  it("loads JSON and applies schema defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-config-"));
    const filePath = join(root, "valid.json");
    await writeFile(filePath, JSON.stringify({ model }), "utf8");

    await expect(loadConfig(filePath)).resolves.toMatchObject({
      name: "mingxu",
      model,
      maxIterations: 10,
      plugins: [],
    });
  });

  it("distinguishes malformed JSON from invalid configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-config-errors-"));
    const malformedPath = join(root, "malformed.json");
    const invalidPath = join(root, "invalid.json");
    await writeFile(malformedPath, "{", "utf8");
    await writeFile(invalidPath, JSON.stringify({ name: "missing model" }), "utf8");

    await expect(loadConfig(malformedPath)).rejects.toThrow("Config file is not valid JSON");
    await expect(loadConfig(invalidPath)).rejects.toThrow("Invalid config file");
    await expect(loadConfig(" ")).rejects.toThrow("Config file path cannot be empty");
  });
});
