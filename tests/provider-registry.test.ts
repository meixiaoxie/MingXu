import { describe, expect, it, vi } from "vitest";

import {
  resolveAgentConfig,
  type ModelConfig,
  type ResolvedAgentConfig,
} from "../src/config/config-schema.js";
import { defaultModelCapabilities } from "../src/models/model-capabilities.js";
import { registerBuiltinProviders } from "../src/models/provider-catalog.js";
import {
  ProviderRegistry,
  selectModelProvider,
  type ProviderDefinition,
} from "../src/models/provider-registry.js";

function createDefinition(provider = "anthropic"): ProviderDefinition {
  return {
    provider,
    capabilities: defaultModelCapabilities,
    create: vi.fn(() => ({
      provider,
      capabilities: defaultModelCapabilities,
      async generate() { return { text: "ok", toolCalls: [] }; },
    })),
  };
}

function createResolvedConfig(overrides: Partial<ResolvedAgentConfig> = {}): ResolvedAgentConfig {
  const config = resolveAgentConfig({
    defaultModel: "primary",
    models: { primary: { provider: "anthropic", model: "claude-sonnet-5" } },
  });
  return { ...config, ...overrides };
}

describe("ProviderRegistry", () => {
  it("registers providers and creates adapters from full model config", () => {
    const definition = createDefinition("openai");
    const registry = new ProviderRegistry();
    const config = {
      provider: "openai",
      model: "gpt-test",
      apiKey: "test-key",
    } satisfies ModelConfig;

    expect(registry.register(definition)).toBe(registry);
    expect(registry.get("openai")).toBe(definition);
    expect(registry.create(config).provider).toBe("openai");
    expect(definition.create).toHaveBeenCalledWith(config);
  });

  it("keeps the complete built-in provider catalog available", () => {
    const registry = registerBuiltinProviders(new ProviderRegistry());
    expect(registry.list().map((definition) => definition.provider)).toEqual([
      "anthropic",
      "openai-compatible",
      "openai",
      "deepseek",
      "kimi",
      "zhipu",
      "glm",
      "gemini",
      "custom",
    ]);
  });

  it("resolves aliases while direct provider names keep their normal match", () => {
    const definition = createDefinition();
    const registry = new ProviderRegistry().registerProvider(definition);
    registry.registerAlias("claude", "anthropic");

    expect(registry.get("anthropic")).toBe(definition);
    expect(registry.get(" claude ")).toBe(definition);
    expect(registry.get("CLAUDE")).toBeUndefined();
    expect(registry.create({ provider: "claude", model: "sonnet" }).provider).toBe("anthropic");
  });

  it("rejects alias conflicts, unknown targets, and invalid provider names", () => {
    const registry = new ProviderRegistry().registerProvider(createDefinition());
    registry.registerAlias("claude", "anthropic");

    expect(() => registry.registerAlias(" claude ", "anthropic")).toThrow(
      "Provider alias already registered: claude",
    );
    expect(() => registry.registerAlias("anthropic", "anthropic")).toThrow(
      "Provider alias conflicts with registered provider: anthropic",
    );
    expect(() => registry.registerProvider(createDefinition("claude"))).toThrow(
      "Provider name conflicts with registered alias: claude",
    );
    expect(() => registry.registerAlias("chat", "missing")).toThrow(
      'Invalid provider alias "chat": target provider is not registered: missing',
    );
    expect(() => registry.register(createDefinition(" anthropic "))).toThrow(
      "Provider name cannot have surrounding whitespace:  anthropic ",
    );
    expect(() => registry.create({ provider: "missing", model: "test" })).toThrow(
      "Unsupported model provider: missing",
    );
  });

  it("registers configured aliases only after built-in providers", () => {
    const registry = registerBuiltinProviders(new ProviderRegistry(), { work: "openai" });
    expect(registry.get("work")?.provider).toBe("openai");
    expect(() => registerBuiltinProviders(new ProviderRegistry(), { bad: "not-installed" })).toThrow(
      'Invalid provider alias "bad": target provider is not registered: not-installed',
    );
  });
});

describe("selectModelProvider", () => {
  it("selects the default model and preserves provider metadata", () => {
    expect(selectModelProvider(createResolvedConfig())).toEqual({
      modelKey: "primary",
      model: { provider: "anthropic", model: "claude-sonnet-5" },
    });

    const config = resolveAgentConfig({
      defaultModel: "fast",
      models: { fast: { provider: "work", model: "gpt-test" } },
      providers: { work: "openai" },
    });
    expect(selectModelProvider(config).provider).toMatchObject({
      name: "work",
      targetProvider: "openai",
    });
  });

  it("rejects unknown model keys and missing provider metadata", () => {
    expect(() => selectModelProvider(createResolvedConfig(), "missing")).toThrow(
      "Unknown model key: missing",
    );
    const malformed = createResolvedConfig({
      models: { broken: { provider: "missing-provider", model: "external-model" } },
      defaultModel: "broken",
      model: { provider: "missing-provider", model: "external-model" },
    });
    expect(() => selectModelProvider(malformed)).toThrow(
      "Model 'broken' references undefined provider: missing-provider",
    );
  });
});
