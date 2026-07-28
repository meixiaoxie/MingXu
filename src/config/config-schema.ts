import { z } from "zod";

import { DEFAULT_MAX_ITERATIONS } from "../core/runtime-defaults.js";

const identifierSchema = z.string().trim().min(1);

// Connection fields are shared, while unknown fields remain available to the
// selected adapter. This preserves provider-specific options such as headers.
const providerOptionsSchema = z.object({
  apiKey: identifierSchema.optional(),
  baseUrl: z.string().trim().url().optional(),
}).catchall(z.unknown());

/** A model entry names the provider it uses and the provider-specific model id. */
export const modelConfigSchema = providerOptionsSchema.extend({
  provider: identifierSchema,
  model: identifierSchema,
});

export const providerConfigSchema = providerOptionsSchema;

// Named custom providers remain compatible with the richer configuration shape
// introduced earlier; one shared module can also register several definitions.
export const customProviderConfigSchema = z.union([
  identifierSchema,
  providerOptionsSchema.extend({ module: identifierSchema }),
]);
const sharedCustomProvidersSchema = z.object({ module: identifierSchema }).strict();
const namedCustomProvidersSchema = z.record(customProviderConfigSchema);
const customProvidersInputSchema = z.union([
  sharedCustomProvidersSchema,
  namedCustomProvidersSchema,
]).default({});

// A string value is an alias target. Object values are retained as provider
// defaults for compatibility and are not treated as aliases.
const providerEntrySchema = z.union([identifierSchema, providerConfigSchema]);
const providersInputSchema = z.record(providerEntrySchema).default({});

const resolvedProviderInputSchema = providerOptionsSchema.extend({
  name: identifierSchema,
  custom: z.boolean(),
  module: identifierSchema.optional(),
  targetProvider: identifierSchema.optional(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
type ProviderInput = z.infer<typeof providerEntrySchema>;
type CustomProviderInput = z.infer<typeof customProviderConfigSchema>;
type CustomProvidersInput = z.infer<typeof customProvidersInputSchema>;

interface ParsedAgentConfigInput {
  name: string;
  systemPrompt?: string | undefined;
  defaultModel?: string | undefined;
  models?: Record<string, ModelConfig> | undefined;
  providers: Record<string, ProviderInput>;
  customProviders: CustomProvidersInput;
  resolvedProviders?: Record<string, z.infer<typeof resolvedProviderInputSchema>> | undefined;
  providerAliases?: Record<string, string> | undefined;
  customProviderModule?: string | undefined;
  model?: ModelConfig | undefined;
  maxIterations: number;
  sessionFile?: string | undefined;
  plugins: string[];
}

const agentConfigInputSchema = z.object({
  name: identifierSchema.default("mingxu"),
  systemPrompt: z.string().optional(),
  defaultModel: identifierSchema.optional(),
  models: z.record(modelConfigSchema).optional(),
  providers: providersInputSchema,
  customProviders: customProvidersInputSchema,
  // These fields make parsing an already resolved value idempotent.
  resolvedProviders: z.record(resolvedProviderInputSchema).optional(),
  providerAliases: z.record(identifierSchema).optional(),
  customProviderModule: identifierSchema.optional(),
  /** @deprecated Use defaultModel and models instead. */
  model: modelConfigSchema.optional(),
  maxIterations: z.number().int().positive().default(DEFAULT_MAX_ITERATIONS),
  sessionFile: identifierSchema.optional(),
  plugins: z.array(identifierSchema).default([]),
}).strict().superRefine((config, context) => {
  validateConfigReferences(config, context);
});

export interface CustomProviderConfig extends ProviderConfig {
  readonly module: string;
}

export interface ResolvedProviderConfig extends ProviderConfig {
  readonly name: string;
  readonly custom: boolean;
  readonly module?: string;
  readonly targetProvider?: string;
}

export interface ResolvedAgentConfig {
  readonly name: string;
  readonly systemPrompt?: string;
  readonly defaultModel: string;
  readonly models: Readonly<Record<string, ModelConfig>>;
  /** Provider-level defaults, excluding string alias entries. */
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  /** Alias-to-built-in-provider mapping consumed during registry setup. */
  readonly providerAliases: Readonly<Record<string, string>>;
  readonly customProviders: Readonly<Record<string, CustomProviderConfig>>;
  /** Optional shared module declared as `customProviders.module`. */
  readonly customProviderModule?: string;
  /** Providers from input maps, ready for runtime selection. */
  readonly resolvedProviders: Readonly<Record<string, ResolvedProviderConfig>>;
  /** @deprecated Compatibility alias for models[defaultModel]. */
  readonly model: ModelConfig;
  readonly maxIterations: number;
  readonly sessionFile?: string;
  readonly plugins: readonly string[];
}

/** Parses authored configuration and produces one canonical runtime shape. */
export const agentConfigSchema = agentConfigInputSchema.transform(resolveParsedConfig);

export type AgentConfigInput = z.input<typeof agentConfigInputSchema>;
export type AgentConfig = ResolvedAgentConfig;

/** Normalizes an in-memory config through the same path used for JSON files. */
export function resolveAgentConfig(config: AgentConfigInput): ResolvedAgentConfig {
  return agentConfigSchema.parse(config);
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

function validateConfigReferences(
  config: ParsedAgentConfigInput,
  context: z.RefinementCtx,
): void {
  const hasNamedModels = config.defaultModel !== undefined || config.models !== undefined;
  if (!hasNamedModels && config.model === undefined) {
    addIssue(context, ["defaultModel"], "defaultModel and models are required when model is not provided");
    return;
  }
  if (hasNamedModels && config.defaultModel === undefined) {
    addIssue(context, ["defaultModel"], "defaultModel is required when models is provided");
  }
  if (hasNamedModels && config.models === undefined) {
    addIssue(context, ["models"], "models is required when defaultModel is provided");
  }

  validateNormalizedKeys(config.models ?? {}, "models", context);
  validateNormalizedKeys(config.providers, "providers", context);
  const namedCustomProviders = isSharedCustomProviders(config.customProviders)
    ? {}
    : config.customProviders;
  validateNormalizedKeys(namedCustomProviders, "customProviders", context);

  const models = normalizeRecord(config.models ?? {});
  const providerEntries = normalizeRecord(config.providers);
  const customProviders = normalizeRecord(namedCustomProviders);
  const defaultModel = config.defaultModel?.trim();

  if (defaultModel !== undefined && models[defaultModel] === undefined) {
    addIssue(context, ["defaultModel"], `defaultModel references unknown model: ${defaultModel}`);
  }

  const knownProviders = new Set([
    ...BUILTIN_PROVIDER_NAMES,
    ...Object.keys(providerEntries),
    ...Object.keys(customProviders),
  ]);
  const sharedModuleCanRegisterUnknownProviders = isSharedCustomProviders(config.customProviders);
  for (const [modelName, model] of Object.entries(models)) {
    if (!knownProviders.has(model.provider) && !sharedModuleCanRegisterUnknownProviders) {
      addIssue(
        context,
        ["models", modelName, "provider"],
        `Model '${modelName}' references unknown provider: ${model.provider}`,
      );
    }
  }

  for (const [alias, value] of Object.entries(providerEntries)) {
    if (typeof value === "string" && !BUILTIN_PROVIDER_NAMES.has(value)) {
      addIssue(
        context,
        ["providers", alias],
        `Provider alias '${alias}' targets unknown built-in provider: ${value}`,
      );
    }
    if (customProviders[alias] !== undefined) {
      addIssue(
        context,
        ["customProviders", alias],
        `Provider key is declared in both providers and customProviders: ${alias}`,
      );
    }
  }
}

function validateNormalizedKeys(
  record: Readonly<Record<string, unknown>>,
  field: "models" | "providers" | "customProviders",
  context: z.RefinementCtx,
): void {
  const normalizedKeys = new Set<string>();
  for (const key of Object.keys(record)) {
    const normalized = key.trim();
    if (!normalized) {
      addIssue(context, [field, key], `${field} keys cannot be empty`);
    } else if (normalizedKeys.has(normalized)) {
      addIssue(context, [field, key], `Duplicate ${field} key after trimming: ${normalized}`);
    }
    normalizedKeys.add(normalized);
  }
}

function resolveParsedConfig(config: ParsedAgentConfigInput): ResolvedAgentConfig {
  const inputModels = config.models === undefined
    ? { default: config.model as ModelConfig }
    : normalizeRecord(config.models);
  const defaultModel = config.models === undefined ? "default" : config.defaultModel as string;
  const providerEntries = normalizeRecord(config.providers);
  const providers: Record<string, ProviderConfig> = {};
  const providerAliases: Record<string, string> = {};
  for (const [name, value] of Object.entries(providerEntries)) {
    if (typeof value === "string") providerAliases[name] = value;
    else providers[name] = value;
  }

  const sharedCustomModule = isSharedCustomProviders(config.customProviders)
    ? config.customProviders.module
    : config.customProviderModule;
  const rawCustomProviders = isSharedCustomProviders(config.customProviders)
    ? {}
    : normalizeRecord(config.customProviders);
  const customProviders = Object.fromEntries(
    Object.entries(rawCustomProviders).map(([name, value]) => [
      name,
      typeof value === "string" ? { module: value } : value,
    ]),
  ) as Record<string, CustomProviderConfig>;

  const resolvedProviders: Record<string, ResolvedProviderConfig> = {};
  for (const [name, provider] of Object.entries(providers)) {
    resolvedProviders[name] = { ...provider, name, custom: false };
  }
  for (const [name, targetProvider] of Object.entries(providerAliases)) {
    resolvedProviders[name] = { name, custom: false, targetProvider };
  }
  for (const [name, provider] of Object.entries(customProviders)) {
    resolvedProviders[name] = { ...provider, name, custom: true };
  }

  // Provider-level options are defaults. Model-level options win when one model
  // needs a different endpoint, credential, or adapter-specific value.
  const models = Object.fromEntries(
    Object.entries(inputModels).map(([name, model]) => {
      const providerDefaults = providers[model.provider] ?? customProviders[model.provider];
      if (providerDefaults === undefined) return [name, model];
      const { module: _module, ...runtimeDefaults } = providerDefaults;
      return [name, { ...runtimeDefaults, ...model }];
    }),
  ) as Record<string, ModelConfig>;

  return {
    name: config.name,
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    defaultModel,
    models,
    providers,
    providerAliases,
    customProviders,
    ...(sharedCustomModule !== undefined ? { customProviderModule: sharedCustomModule } : {}),
    resolvedProviders,
    model: models[defaultModel] as ModelConfig,
    maxIterations: config.maxIterations,
    ...(config.sessionFile !== undefined ? { sessionFile: config.sessionFile } : {}),
    plugins: config.plugins,
  };
}

function isSharedCustomProviders(
  value: CustomProvidersInput,
): value is { module: string } {
  return Object.keys(value).length === 1 && typeof value.module === "string";
}

function normalizeRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key.trim(), value]),
  );
}

function addIssue(
  context: z.RefinementCtx,
  path: Array<string | number>,
  message: string,
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}
