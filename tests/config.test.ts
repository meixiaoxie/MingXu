import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentConfigSchema,
  defineAgentConfig,
  loadConfig,
  resolveAgentConfig,
} from "../src/index.js";

const legacyModel = {
  provider: "anthropic",
  model: "claude-sonnet-5",
};

describe("agent config", () => {
  it("resolves the minimal named-model config and applies defaults", () => {
    const config = defineAgentConfig({
      defaultModel: "primary",
      models: { primary: legacyModel },
    });

    expect(config).toMatchObject({
      name: "mingxu",
      defaultModel: "primary",
      model: legacyModel,
      models: { primary: legacyModel },
      providers: {},
      providerAliases: {},
      customProviders: {},
      resolvedProviders: {},
      maxIterations: 10,
      plugins: [],
    });
    expect(agentConfigSchema.safeParse(config).success).toBe(true);
  });

  it("accepts provider aliases and a shared custom provider module", () => {
    const config = resolveAgentConfig({
      defaultModel: "primary",
      models: { primary: { provider: " work ", model: "test" } },
      providers: { " work ": " openai " },
      customProviders: { module: " ./providers.mjs " },
    });

    expect(config.providerAliases).toEqual({ work: "openai" });
    expect(config.customProviderModule).toBe("./providers.mjs");
    expect(config.models.primary?.provider).toBe("work");
  });

  it("merges provider defaults and named custom provider metadata", () => {
    const config = resolveAgentConfig({
      defaultModel: "primary",
      models: {
        primary: {
          provider: "gateway",
          model: "company-assistant",
          apiKey: "model-key",
          headers: { "x-tenant": "engineering" },
        },
      },
      customProviders: {
        gateway: {
          module: "./gateway-provider.js",
          apiKey: "provider-key",
          baseUrl: "https://models.example.test/v1",
          region: "eu-west",
        },
      },
    });

    expect(config.models.primary).toMatchObject({
      provider: "gateway",
      apiKey: "model-key",
      baseUrl: "https://models.example.test/v1",
      region: "eu-west",
    });
    expect(config.resolvedProviders.gateway).toMatchObject({
      name: "gateway",
      custom: true,
      module: "./gateway-provider.js",
    });
  });

  it("keeps legacy model input compatible and preserves adapter options", () => {
    const config = defineAgentConfig({
      model: {
        ...legacyModel,
        protocol: "openai-compatible",
        headers: { authorization: "test" },
      },
    });

    expect(config.defaultModel).toBe("default");
    expect(config.models.default).toEqual(config.model);
    expect(config.model).toMatchObject({
      protocol: "openai-compatible",
      headers: { authorization: "test" },
    });
  });

  it("rejects empty, duplicate, or unsupported alias and module values", () => {
    const base = { defaultModel: "primary", models: { primary: legacyModel } };
    expect(agentConfigSchema.safeParse({ ...base, providers: { " ": "anthropic" } }).success)
      .toBe(false);
    expect(agentConfigSchema.safeParse({ ...base, providers: { work: " " } }).success)
      .toBe(false);
    expect(agentConfigSchema.safeParse({
      ...base,
      providers: { work: "anthropic", " work ": "anthropic" },
    }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ ...base, providers: { work: "missing" } }).success)
      .toBe(false);
    expect(agentConfigSchema.safeParse({ ...base, customProviders: { module: " " } }).success)
      .toBe(false);
  });

  it("normalizes plugin entries and applies trusted_local by default", () => {
    const config = resolveAgentConfig({
      defaultModel: "primary",
      models: { primary: legacyModel },
      plugins: [
        " ./plugins/default.mjs ",
        { path: "./plugins/blocked.mjs", trust: "blocked" },
      ],
    });

    expect(config.plugins).toEqual([
      { path: "./plugins/default.mjs", trust: "trusted_local" },
      { path: "./plugins/blocked.mjs", trust: "blocked" },
    ]);
  });

  it("preserves plugin manifests, kinds, and permissions", () => {
    const config = resolveAgentConfig({
      defaultModel: "primary",
      models: { primary: legacyModel },
      plugins: [{
        path: "./plugins/tool.mjs",
        trust: "trusted_local",
        kind: "tool",
        manifest: "tool-plugin",
        permissions: { files: "read", env: ["API_KEY"] },
      }],
    });

    expect(config.plugins).toEqual([{
      path: "./plugins/tool.mjs",
      trust: "trusted_local",
      kind: "tool",
      manifest: "tool-plugin",
      permissions: { files: "read", env: ["API_KEY"] },
    }]);
  });

  it("rejects invalid plugin trust values", () => {
    expect(agentConfigSchema.safeParse({
      defaultModel: "primary",
      models: { primary: legacyModel },
      plugins: [{ path: "./plugins/test.mjs", trust: "unknown" }],
    }).success).toBe(false);
  });

});

describe("loadConfig", () => {
  it("loads aliases and custom module configuration from JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-config-"));
    const filePath = join(root, "valid.json");
    await writeFile(filePath, JSON.stringify({
      defaultModel: "primary",
      models: { primary: { provider: "work", model: "test" } },
      providers: { work: "anthropic" },
      customProviders: { module: "./providers.mjs" },
    }), "utf8");

    await expect(loadConfig(filePath)).resolves.toMatchObject({
      providerAliases: { work: "anthropic" },
      customProviderModule: "./providers.mjs",
    });
  });

  it("parses the documented multi-provider example", async () => {
    const config = await loadConfig("examples/multi-provider.config.json");

    expect(config.defaultModel).toBe("assistant");
    expect(config.providerAliases).toEqual({ "work-openai": "openai" });
    expect(config.customProviders.gateway).toMatchObject({
      module: "./providers/register-gateway.mjs",
      baseUrl: "https://gateway.example.com/v1/chat/completions",
      apiKey: "gateway-key",
    });
    expect(config.models["gateway-model"]).toMatchObject({
      provider: "gateway",
      model: "internal-chat",
      baseUrl: "https://gateway.example.com/v1/chat/completions",
      apiKey: "gateway-key",
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
