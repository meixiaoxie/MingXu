import type { ModelConfig } from "../config/config-schema.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { defaultModelCapabilities } from "./model-capabilities.js";
import type { ProviderDefinition, ProviderRegistry } from "./provider-registry.js";

const anthropicDefinition: ProviderDefinition = {
  provider: "anthropic",
  capabilities: defaultModelCapabilities,
  create(config: ModelConfig) {
    return new AnthropicProvider({
      apiKey: config.apiKey,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    });
  },
};

export function registerBuiltinProviders(registry: ProviderRegistry): ProviderRegistry {
  registry.register(anthropicDefinition);
  return registry;
}
