import type { ModelConfig } from "../config/config-schema.js";
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

export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderDefinition>();

  register(provider: ProviderDefinition): this {
    const name = provider.provider.trim();
    if (!name) {
      throw new Error("Provider name cannot be empty");
    }
    if (name !== provider.provider) {
      throw new Error(`Provider name cannot have surrounding whitespace: ${provider.provider}`);
    }
    if (this.#providers.has(name)) {
      throw new Error(`Provider already registered: ${name}`);
    }
    this.#providers.set(name, provider);
    return this;
  }

  get(provider: string): ProviderDefinition | undefined {
    return this.#providers.get(provider);
  }

  list(): readonly ProviderDefinition[] {
    return [...this.#providers.values()];
  }

  create(config: ModelConfig): ModelAdapter {
    const definition = this.#providers.get(config.provider);
    if (!definition) {
      throw new Error(`Unsupported model provider: ${config.provider}`);
    }
    return definition.create(config);
  }
}
