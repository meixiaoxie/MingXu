import { describe, expect, it } from "vitest";

import { ProviderRegistry } from "../src/models/provider-registry.js";

describe("ProviderRegistry", () => {
  it("registers and resolves adapters by provider name", () => {
    const registry = new ProviderRegistry();
    const adapter = {
      provider: "anthropic",
      capabilities: {
        supportsTools: true,
        supportsStreaming: true,
        supportsImages: false,
        supportsStructuredOutput: false,
        supportsRefusal: false,
        supportsFallback: false,
        supportsEffort: false,
        supportsPromptCaching: false,
        supportsMidConversationSystem: false,
        maxContext: 128000,
        maxOutput: 8192,
      },
      async generate() {
        return { text: "ok", toolCalls: [] };
      },
    };

    registry.register(adapter);
    expect(registry.get("anthropic")).toBe(adapter);
    expect(registry.create("anthropic")).toBe(adapter);
    expect(registry.list()).toEqual([adapter]);
  });

  it("rejects duplicate or unknown providers", () => {
    const registry = new ProviderRegistry();
    const adapter = {
      provider: "anthropic",
      capabilities: {
        supportsTools: true,
        supportsStreaming: true,
        supportsImages: false,
        supportsStructuredOutput: false,
        supportsRefusal: false,
        supportsFallback: false,
        supportsEffort: false,
        supportsPromptCaching: false,
        supportsMidConversationSystem: false,
        maxContext: 128000,
        maxOutput: 8192,
      },
      async generate() {
        return { text: "ok", toolCalls: [] };
      },
    };

    registry.register(adapter);
    expect(() => registry.register(adapter)).toThrow("Provider already registered: anthropic");
    expect(() => registry.create("openai")).toThrow("Unsupported model provider: openai");
  });
});
