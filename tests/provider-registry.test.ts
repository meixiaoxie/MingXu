import { describe, expect, it, vi } from "vitest";

import type { ModelConfig } from "../src/config/config-schema.js";
import { defaultModelCapabilities } from "../src/models/model-capabilities.js";
import { ProviderRegistry } from "../src/models/provider-registry.js";

describe("ProviderRegistry", () => {
  it("registers providers and creates adapters from model config", () => {
    const adapter = {
      provider: "anthropic",
      capabilities: defaultModelCapabilities,
      async generate() {
        return { text: "ok", toolCalls: [] };
      },
    };
    const create = vi.fn(() => adapter);
    const providerDefinition = {
      provider: "anthropic",
      capabilities: defaultModelCapabilities,
      create,
    };
    const registry = new ProviderRegistry();
    const config = {
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "test-key",
      baseUrl: "https://example.test/v1/messages",
    } satisfies ModelConfig;

    expect(registry.register(providerDefinition)).toBe(registry);
    expect(registry.get("anthropic")).toBe(providerDefinition);
    expect(registry.list()).toEqual([providerDefinition]);
    expect(registry.create(config)).toBe(adapter);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(config);
  });

  it("rejects duplicate, unknown, and invalid provider names", () => {
    const registry = new ProviderRegistry();
    const providerDefinition = {
      provider: "anthropic",
      capabilities: defaultModelCapabilities,
      create: vi.fn(),
    };

    registry.register(providerDefinition);

    expect(() => registry.register(providerDefinition)).toThrow(
      "Provider already registered: anthropic",
    );
    expect(() => registry.register({ ...providerDefinition, provider: " anthropic " })).toThrow(
      "Provider name cannot have surrounding whitespace:  anthropic ",
    );
    expect(() => registry.register({ ...providerDefinition, provider: " " })).toThrow(
      "Provider name cannot be empty",
    );
    expect(() => registry.create({ provider: "openai", model: "gpt-4" } as ModelConfig)).toThrow(
      "Unsupported model provider: openai",
    );
  });
});
