import type { ModelConfig } from "../config/config-schema.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { CustomProvider } from "./custom-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { defaultModelCapabilities } from "./model-capabilities.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import type { ProviderCreateOptions, ProviderDefinition, ProviderRegistry } from "./provider-registry.js";

const OPENAI_COMPATIBLE_PROVIDERS = {
  "openai-compatible": {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  kimi: {
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "KIMI_API_KEY",
  },
  zhipu: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
    apiKeyEnv: "ZHIPU_API_KEY",
  },
  glm: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
    apiKeyEnv: "GLM_API_KEY",
  },
} as const;

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

const geminiDefinition: ProviderDefinition = {
  provider: "gemini",
  capabilities: { ...defaultModelCapabilities, supportsStructuredOutput: true },
  create(config: ModelConfig) {
    return new GeminiProvider({
      apiKey: config.apiKey,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    });
  },
};

const customDefinition: ProviderDefinition = {
  provider: "custom",
  capabilities: { ...defaultModelCapabilities, supportsStructuredOutput: true },
  create(config: ModelConfig) {
    if (config.baseUrl === undefined) {
      throw new Error("Custom provider baseUrl is required");
    }
    return new CustomProvider({
      baseUrl: config.baseUrl,
      ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
      ...(config.protocol !== undefined
        ? { protocol: config.protocol as "openai-compatible" }
        : {}),
    });
  },
};

function createOpenAICompatibleDefinition(
  provider: keyof typeof OPENAI_COMPATIBLE_PROVIDERS,
): ProviderDefinition {
  const defaults = OPENAI_COMPATIBLE_PROVIDERS[provider];
  return {
    provider,
    capabilities: defaultModelCapabilities,
    create(config: ModelConfig, options?: ProviderCreateOptions) {
      return new OpenAICompatibleProvider({
        provider,
        apiKey: config.apiKey,
        apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : defaults.apiKeyEnv,
        baseUrl: config.baseUrl ?? defaults.baseUrl,
        ...(options?.debug !== undefined ? { debug: options.debug } : {}),
      });
    },
  };
}

/** Registers shipped providers first, then validates aliases against that catalog. */
export function registerBuiltinProviders(
  registry: ProviderRegistry,
  aliases: Readonly<Record<string, string>> = {},
): ProviderRegistry {
  registry.registerProvider(anthropicDefinition);
  for (const provider of Object.keys(OPENAI_COMPATIBLE_PROVIDERS) as Array<
    keyof typeof OPENAI_COMPATIBLE_PROVIDERS
  >) {
    registry.registerProvider(createOpenAICompatibleDefinition(provider));
  }
  registry.registerProvider(geminiDefinition);
  registry.registerProvider(customDefinition);

  // Alias targets must already exist, preventing an alias from accidentally
  // reaching a custom module whose registration order is user-controlled.
  for (const [alias, provider] of Object.entries(aliases)) {
    registry.registerAlias(alias, provider);
  }
  return registry;
}
