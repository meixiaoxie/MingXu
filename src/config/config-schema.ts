import { z } from "zod";

import {
  DEFAULT_MAX_CONCURRENT_TOOLS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_MODEL_REQUESTS,
  DEFAULT_MAX_TOOL_CALLS,
} from "../core/runtime-defaults.js";

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

const pluginPermissionsSchema = z.object({
  files: z.enum(["none", "read", "write"]).optional(),
  network: z.enum(["none", "allow"]).optional(),
  commands: z.enum(["none", "allow"]).optional(),
  env: z.array(identifierSchema).optional(),
}).strict();

const pluginManifestSchema = z.object({
  name: identifierSchema,
  version: identifierSchema,
  kind: z.enum(["tool", "provider", "memory", "policy", "audit", "context", "preset"]),
  permissions: pluginPermissionsSchema.optional(),
}).strict();

const instructionScopeConfigSchema = z.object({
  dir: identifierSchema.optional(),
  file: identifierSchema.optional(),
  files: z.array(identifierSchema).optional(),
}).strict();

const instructionConfigSchema = z.object({
  managed: instructionScopeConfigSchema.optional(),
  user: instructionScopeConfigSchema.optional(),
  project: instructionScopeConfigSchema.optional(),
  local: instructionScopeConfigSchema.optional(),
  session: instructionScopeConfigSchema.optional(),
  autoLoadClaudeMd: z.boolean().optional(),
  maxInstructionBytes: z.number().int().positive().optional(),
  maxTotalBytes: z.number().int().positive().optional(),
}).strict();

const memoryScopeConfigSchema = z.object({
  dir: identifierSchema.optional(),
  readOnly: z.boolean().optional(),
}).strict();

const memoryConfigSchema = z.object({
  managed: memoryScopeConfigSchema.optional(),
  user: memoryScopeConfigSchema.optional(),
  project: memoryScopeConfigSchema.optional(),
  local: memoryScopeConfigSchema.optional(),
  maxQueryEntries: z.number().int().positive().optional(),
  maxEntryBytes: z.number().int().positive().optional(),
}).strict();

const resourceScopeConfigSchema = z.object({
  dir: identifierSchema.optional(),
  files: z.array(identifierSchema).optional(),
}).strict();

const resourceConfigSchema = z.object({
  managed: resourceScopeConfigSchema.optional(),
  user: resourceScopeConfigSchema.optional(),
  project: resourceScopeConfigSchema.optional(),
  local: resourceScopeConfigSchema.optional(),
  session: resourceScopeConfigSchema.optional(),
  maxResourceBytes: z.number().int().positive().optional(),
  maxRunBytes: z.number().int().positive().optional(),
}).strict();

const skillConfigSchema = z.object({
  dirs: z.array(identifierSchema).optional(),
  maxSkillBytes: z.number().int().positive().optional(),
}).strict();

const mcpToolConfigSchema = z.object({
  riskLevel: z.enum(["low", "high"]).optional(),
  executionMode: z.enum(["sequential", "parallel"]).optional(),
}).passthrough();

const mcpServerConfigSchema = z.object({
  transport: z.enum(["stdio", "streamable_http"]),
  command: identifierSchema.optional(),
  args: z.array(identifierSchema).optional(),
  url: z.string().trim().url().optional(),
  env: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  tools: z.record(mcpToolConfigSchema).optional(),
}).passthrough();

const presetConfigSchema = z.object({
  version: z.literal("v1"),
  name: identifierSchema,
  description: z.string().min(1),
  modelKey: identifierSchema.optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(identifierSchema).optional(),
  resources: z.array(identifierSchema).optional(),
  tools: z.array(identifierSchema).optional(),
  maxIterations: z.number().int().positive().optional(),
  runtime: z.object({
    maxConcurrentTools: z.number().int().positive().optional(),
    maxDepth: z.number().int().positive().optional(),
    maxConcurrentSubagents: z.number().int().positive().optional(),
  }).optional(),
}).passthrough();

const subagentConfigSchema = z.object({
  enabled: z.boolean().optional(),
  maxDepth: z.number().int().positive().optional(),
  maxConcurrentSubagents: z.number().int().positive().optional(),
}).strict();

export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
type ProviderInput = z.infer<typeof providerEntrySchema>;
type CustomProviderInput = z.infer<typeof customProviderConfigSchema>;
type CustomProvidersInput = z.infer<typeof customProvidersInputSchema>;
type PluginEntryInput = z.infer<typeof pluginEntrySchema>;

type PluginTrust = "trusted_local" | "blocked";

const pluginTrustSchema = z.enum(["trusted_local", "blocked"]);
const pluginEntrySchema = z.union([
  identifierSchema,
  z.object({
    path: identifierSchema,
    trust: pluginTrustSchema.default("trusted_local"),
    kind: z.enum(["tool", "provider", "memory", "policy", "audit", "context", "preset"]).optional(),
    manifest: identifierSchema.optional(),
    permissions: pluginPermissionsSchema.optional(),
  }).strict(),
]);
const pluginsInputSchema = z.array(pluginEntrySchema).default([]);

export interface PluginConfig {
  readonly path: string;
  readonly trust: PluginTrust;
  readonly kind?: z.infer<typeof pluginManifestSchema>["kind"];
  readonly manifest?: string;
  readonly permissions?: z.infer<typeof pluginPermissionsSchema>;
}

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
  runtime?: {
    limits?: {
      maxIterations?: number | undefined;
      maxModelRequests?: number | undefined;
      maxToolCalls?: number | undefined;
      maxDurationMs?: number | undefined;
      maxConcurrentTools?: number | undefined;
    } | undefined;
  } | undefined;
  audit?: {
    enabled?: boolean | undefined;
    file?: string | undefined;
    maxBytes?: number | undefined;
    maxFiles?: number | undefined;
    failClosedForHighRisk?: boolean | undefined;
  } | undefined;
  redaction?: {
    enabled?: boolean | undefined;
    redactSession?: boolean | undefined;
    redactErrors?: boolean | undefined;
  } | undefined;
  secrets?: {
    allowEnv?: boolean | undefined;
  } | undefined;
  session?: {
    enabled?: boolean | undefined;
    dir?: string | undefined;
    retentionDays?: number | undefined;
    save?: boolean | undefined;
  } | undefined;
  sessionFile?: string | undefined;
  instructions?: z.infer<typeof instructionConfigSchema> | undefined;
  memory?: z.infer<typeof memoryConfigSchema> | undefined;
  resources?: z.infer<typeof resourceConfigSchema> | undefined;
  skills?: z.infer<typeof skillConfigSchema> | undefined;
  mcpServers?: Record<string, z.infer<typeof mcpServerConfigSchema>> | undefined;
  presets?: Record<string, z.infer<typeof presetConfigSchema>> | undefined;
  defaultPreset?: string | undefined;
  subagents?: z.infer<typeof subagentConfigSchema> | undefined;
  plugins: PluginEntryInput[];
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
  runtime: z.object({
    limits: z.object({
      maxIterations: z.number().int().positive().optional(),
      maxModelRequests: z.number().int().positive().default(DEFAULT_MAX_MODEL_REQUESTS),
      maxToolCalls: z.number().int().positive().default(DEFAULT_MAX_TOOL_CALLS),
      maxDurationMs: z.number().positive().optional(),
      maxConcurrentTools: z.number().int().positive().default(DEFAULT_MAX_CONCURRENT_TOOLS),
    }).optional(),
  }).optional(),
  audit: z.object({
    enabled: z.boolean().optional(),
    file: identifierSchema.optional(),
    maxBytes: z.number().int().positive().optional(),
    maxFiles: z.number().int().positive().optional(),
    failClosedForHighRisk: z.boolean().optional(),
  }).optional(),
  redaction: z.object({
    enabled: z.boolean().optional(),
    redactSession: z.boolean().optional(),
    redactErrors: z.boolean().optional(),
  }).optional(),
  secrets: z.object({
    allowEnv: z.boolean().optional(),
  }).optional(),
  session: z.object({
    enabled: z.boolean().optional(),
    dir: identifierSchema.optional(),
    retentionDays: z.number().int().positive().optional(),
    save: z.boolean().optional(),
  }).optional(),
  sessionFile: identifierSchema.optional(),
  instructions: instructionConfigSchema.optional(),
  memory: memoryConfigSchema.optional(),
  resources: resourceConfigSchema.optional(),
  skills: skillConfigSchema.optional(),
  mcpServers: z.record(mcpServerConfigSchema).optional(),
  presets: z.record(presetConfigSchema).optional(),
  defaultPreset: identifierSchema.optional(),
  subagents: subagentConfigSchema.optional(),
  plugins: pluginsInputSchema,
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
  readonly runtime?: {
    readonly limits?: {
      readonly maxIterations?: number;
      readonly maxModelRequests?: number;
      readonly maxToolCalls?: number;
      readonly maxDurationMs?: number;
      readonly maxConcurrentTools?: number;
    };
  };
  readonly audit?: {
    readonly enabled?: boolean;
    readonly file?: string;
    readonly maxBytes?: number;
    readonly maxFiles?: number;
    readonly failClosedForHighRisk?: boolean;
  };
  readonly redaction?: {
    readonly enabled?: boolean;
    readonly redactSession?: boolean;
    readonly redactErrors?: boolean;
  };
  readonly secrets?: {
    readonly allowEnv?: boolean;
  };
  readonly session?: {
    readonly enabled?: boolean;
    readonly dir?: string;
    readonly retentionDays?: number;
    readonly save?: boolean;
  };
  readonly sessionFile?: string;
  readonly instructions?: z.infer<typeof instructionConfigSchema>;
  readonly memory?: z.infer<typeof memoryConfigSchema>;
  readonly resources?: z.infer<typeof resourceConfigSchema>;
  readonly skills?: z.infer<typeof skillConfigSchema>;
  readonly mcpServers?: Readonly<Record<string, z.infer<typeof mcpServerConfigSchema>>>;
  readonly presets?: Readonly<Record<string, z.infer<typeof presetConfigSchema>>>;
  readonly defaultPreset?: string;
  readonly subagents?: z.infer<typeof subagentConfigSchema>;
  readonly plugins: readonly PluginConfig[];
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
      const mergedModel: ModelConfig = { ...runtimeDefaults, ...model };
      return [name, mergedModel];
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
    maxIterations: config.runtime?.limits?.maxIterations ?? config.maxIterations,
    ...(config.runtime !== undefined
      ? {
          runtime: {
            ...(config.runtime.limits !== undefined
              ? {
                  limits: {
                    ...(config.runtime.limits.maxIterations !== undefined ? { maxIterations: config.runtime.limits.maxIterations } : {}),
                    ...(config.runtime.limits.maxModelRequests !== undefined ? { maxModelRequests: config.runtime.limits.maxModelRequests } : {}),
                    ...(config.runtime.limits.maxToolCalls !== undefined ? { maxToolCalls: config.runtime.limits.maxToolCalls } : {}),
                    ...(config.runtime.limits.maxDurationMs !== undefined ? { maxDurationMs: config.runtime.limits.maxDurationMs } : {}),
                    ...(config.runtime.limits.maxConcurrentTools !== undefined ? { maxConcurrentTools: config.runtime.limits.maxConcurrentTools } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(config.audit !== undefined
      ? {
          audit: {
            ...(config.audit.enabled !== undefined ? { enabled: config.audit.enabled } : {}),
            ...(config.audit.file !== undefined ? { file: config.audit.file } : {}),
            ...(config.audit.maxBytes !== undefined ? { maxBytes: config.audit.maxBytes } : {}),
            ...(config.audit.maxFiles !== undefined ? { maxFiles: config.audit.maxFiles } : {}),
            ...(config.audit.failClosedForHighRisk !== undefined
              ? { failClosedForHighRisk: config.audit.failClosedForHighRisk }
              : {}),
          },
        }
      : {}),
    ...(config.redaction !== undefined
      ? {
          redaction: {
            ...(config.redaction.enabled !== undefined ? { enabled: config.redaction.enabled } : {}),
            ...(config.redaction.redactSession !== undefined ? { redactSession: config.redaction.redactSession } : {}),
            ...(config.redaction.redactErrors !== undefined ? { redactErrors: config.redaction.redactErrors } : {}),
          },
        }
      : {}),
    ...(config.secrets !== undefined
      ? {
          secrets: {
            ...(config.secrets.allowEnv !== undefined ? { allowEnv: config.secrets.allowEnv } : {}),
          },
        }
      : {}),
    ...(config.session !== undefined
      ? {
          session: {
            ...(config.session.enabled !== undefined ? { enabled: config.session.enabled } : {}),
            ...(config.session.dir !== undefined ? { dir: config.session.dir } : {}),
            ...(config.session.retentionDays !== undefined ? { retentionDays: config.session.retentionDays } : {}),
            ...(config.session.save !== undefined ? { save: config.session.save } : {}),
          },
        }
      : {}),
    ...(config.sessionFile !== undefined ? { sessionFile: config.sessionFile } : {}),
    ...(config.instructions !== undefined ? { instructions: config.instructions } : {}),
    ...(config.memory !== undefined ? { memory: config.memory } : {}),
    ...(config.resources !== undefined ? { resources: config.resources } : {}),
    ...(config.skills !== undefined ? { skills: config.skills } : {}),
    ...(config.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {}),
    ...(config.presets !== undefined ? { presets: config.presets } : {}),
    ...(config.defaultPreset !== undefined ? { defaultPreset: config.defaultPreset } : {}),
    ...(config.subagents !== undefined ? { subagents: config.subagents } : {}),
    plugins: normalizePlugins(config.plugins),
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

function normalizePlugins(plugins: readonly PluginEntryInput[]): PluginConfig[] {
  return plugins.map((plugin) => {
    if (typeof plugin === "string") {
      return { path: plugin, trust: "trusted_local" };
    }
    return {
      path: plugin.path,
      trust: plugin.trust,
      ...(plugin.kind !== undefined ? { kind: plugin.kind } : {}),
      ...(plugin.manifest !== undefined ? { manifest: plugin.manifest } : {}),
      ...(plugin.permissions !== undefined ? { permissions: plugin.permissions } : {}),
    };
  });
}

function addIssue(
  context: z.RefinementCtx,
  path: Array<string | number>,
  message: string,
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}
