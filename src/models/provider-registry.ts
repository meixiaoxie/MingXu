import type {
  ModelConfig,
  ResolvedAgentConfig,
  ResolvedProviderConfig,
} from "../config/config-schema.js";
import type { ModelCapabilities } from "./model-capabilities.js";
import type { ModelEvent, ModelRequest, ModelResponse } from "./model-protocol.js";

export interface ModelAdapter {
  readonly provider: string;
  readonly capabilities: ModelCapabilities;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelEvent> | Promise<AsyncIterable<ModelEvent>>;
}

export interface ProviderDefinition {
  readonly provider: string;
  readonly capabilities: ModelCapabilities;
  create(config: ModelConfig): ModelAdapter;
}

/** Everything the runtime needs after resolving one named model entry. */
export interface ProviderSelection {
  readonly modelKey: string;
  readonly model: ModelConfig;
  readonly provider?: ResolvedProviderConfig;
}

/** Selects one model from canonical config and validates declared provider metadata. */
export function selectModelProvider(
  config: ResolvedAgentConfig,
  modelKey = config.defaultModel,
): ProviderSelection {
  const normalizedKey = modelKey.trim();
  if (!normalizedKey) {
    throw new Error("Model key cannot be empty");
  }

  const model = config.models[normalizedKey];
  if (!model) {
    throw new Error(`Unknown model key: ${normalizedKey}`);
  }

  const provider = config.resolvedProviders[model.provider];
  if (!provider && !BUILTIN_PROVIDER_NAMES.has(model.provider)
    && config.customProviderModule === undefined) {
    throw new Error(`Model '${normalizedKey}' references undefined provider: ${model.provider}`);
  }

  return {
    modelKey: normalizedKey,
    model,
    ...(provider !== undefined ? { provider } : {}),
  };
}

const BUILTIN_PROVIDER_NAMES = new Set([
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

/** Provider names and aliases are trimmed but remain case-sensitive. */
function normalizeName(name: string): string {
  return name.trim();
}

export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderDefinition>();
  readonly #aliases = new Map<string, string>();

  /** Registers a real provider implementation, as distinct from a configured alias. */
  registerProvider(provider: ProviderDefinition): this {
    const name = normalizeName(provider.provider);
    if (!name) {
      throw new Error("Provider name cannot be empty");
    }
    // Definition names are authored in code, so surrounding whitespace is most
    // likely a registration bug rather than user input that should be corrected.
    if (name !== provider.provider) {
      throw new Error(`Provider name cannot have surrounding whitespace: ${provider.provider}`);
    }
    if (this.#providers.has(name)) {
      throw new Error(`Provider already registered: ${name}`);
    }
    if (this.#aliases.has(name)) {
      throw new Error(`Provider name conflicts with registered alias: ${name}`);
    }
    this.#providers.set(name, provider);
    return this;
  }

  /** Keeps the original API available while making real-provider registration explicit. */
  register(provider: ProviderDefinition): this {
    return this.registerProvider(provider);
  }

  /** Registers an alias only after its real target has been registered. */
  registerAlias(alias: string, provider: string): this {
    const normalizedAlias = normalizeName(alias);
    const normalizedProvider = normalizeName(provider);
    if (!normalizedAlias) {
      throw new Error("Invalid provider alias: alias name cannot be empty");
    }
    if (!normalizedProvider) {
      throw new Error(`Invalid provider alias "${normalizedAlias}": target cannot be empty`);
    }
    if (this.#providers.has(normalizedAlias)) {
      throw new Error(`Provider alias conflicts with registered provider: ${normalizedAlias}`);
    }
    if (this.#aliases.has(normalizedAlias)) {
      throw new Error(`Provider alias already registered: ${normalizedAlias}`);
    }
    if (!this.#providers.has(normalizedProvider)) {
      throw new Error(
        `Invalid provider alias "${normalizedAlias}": target provider is not registered: ${normalizedProvider}`,
      );
    }
    this.#aliases.set(normalizedAlias, normalizedProvider);
    return this;
  }

  get(provider: string): ProviderDefinition | undefined {
    const name = normalizeName(provider);
    const directMatch = this.#providers.get(name);
    if (directMatch) return directMatch;

    const aliasTarget = this.#aliases.get(name);
    return aliasTarget === undefined ? undefined : this.#providers.get(aliasTarget);
  }

  list(): readonly ProviderDefinition[] {
    return [...this.#providers.values()];
  }

  create(config: ModelConfig): ModelAdapter {
    const definition = this.get(config.provider);
    if (!definition) {
      throw new Error(`Unsupported model provider: ${normalizeName(config.provider)}`);
    }
    return definition.create(config);
  }

  /** Selects the configured model before creating its adapter in one safe step. */
  createFromConfig(
    config: ResolvedAgentConfig,
    modelKey = config.defaultModel,
  ): { readonly selection: ProviderSelection; readonly adapter: ModelAdapter } {
    const selection = selectModelProvider(config, modelKey);
    return {
      selection,
      adapter: this.create(selection.model),
    };
  }
}
