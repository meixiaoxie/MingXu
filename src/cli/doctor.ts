import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ResolvedAgentConfig } from "../config/config-schema.js";
import { parseSecretRef } from "../redaction/secret-ref.js";
import { resolvePluginLoadRequest } from "../plugins/plugin-loader.js";
import { ProviderRegistry } from "../models/provider-registry.js";
import { registerBuiltinProviders } from "../models/provider-catalog.js";
import { loadCustomProviderModule } from "../models/custom-provider-loader.js";

export interface DoctorDependencies {
  readonly fetchProbe?: (config: ResolvedAgentConfig) => Promise<void>;
}

export interface DoctorOptions {
  readonly config: ResolvedAgentConfig;
  readonly configPath: string;
  readonly online: boolean;
}

interface DoctorCheckResult {
  readonly level: "PASS" | "WARN" | "FAIL";
  readonly label: string;
  readonly detail: string;
}

export interface DoctorRunResult {
  readonly ok: boolean;
  readonly output: string;
}

/**
 * Runs a lightweight local health check over the generated runtime config.
 *
 * The offline path avoids side effects: it validates references and filesystem
 * targets, but it does not execute plugins or perform network calls.
 */
export async function runDoctor(
  options: DoctorOptions,
  dependencies: DoctorDependencies = {},
): Promise<DoctorRunResult> {
  const results: DoctorCheckResult[] = [];

  results.push({
    level: "PASS",
    label: "config",
    detail: `Loaded config from ${resolve(options.configPath)}`,
  });

  const envChecks = collectEnvChecks(options.config);
  results.push(...envChecks);

  const pluginChecks = await collectPluginChecks(options.config, options.configPath);
  results.push(...pluginChecks);

  const pathChecks = collectPathChecks(options.config, options.configPath);
  results.push(...pathChecks);

  if (options.online) {
    results.push({
      level: "WARN",
      label: "online",
      detail: "Online doctor is enabled. This will access the configured model provider and may incur network usage or cost.",
    });
    try {
      await runOnlineProbe(options.config, options.configPath, dependencies.fetchProbe);
      results.push({
        level: "PASS",
        label: "provider",
        detail: "Successfully completed an online model connectivity probe.",
      });
    } catch (error) {
      results.push({
        level: "FAIL",
        label: "provider",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    results.push({
      level: "WARN",
      label: "online",
      detail: "Skipping network checks. Re-run with --online to verify live provider connectivity.",
    });
  }

  const hasFailures = results.some((result) => result.level === "FAIL");
  return {
    ok: !hasFailures,
    output: results.map((result) => `${result.level} ${result.label}: ${result.detail}`).join("\n"),
  };
}

function collectEnvChecks(config: ResolvedAgentConfig): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];

  for (const [modelName, model] of Object.entries(config.models)) {
    if (typeof model.apiKey !== "string") continue;
    const ref = parseSecretRef(model.apiKey);
    if (!ref) {
      results.push({
        level: "WARN",
        label: `secret:${modelName}`,
        detail: "Model apiKey is configured without env: indirection. Prefer env:VARIABLE to avoid storing secrets in config.",
      });
      continue;
    }

    if (process.env[ref.name]) {
      results.push({
        level: "PASS",
        label: `secret:${modelName}`,
        detail: `Environment variable ${ref.name} is available.`,
      });
    } else {
      results.push({
        level: "FAIL",
        label: `secret:${modelName}`,
        detail: `Missing environment variable ${ref.name}. Set it before running mingxu.`,
      });
    }
  }

  return results;
}

async function collectPluginChecks(
  config: ResolvedAgentConfig,
  configPath: string,
): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];

  for (const plugin of config.plugins) {
    try {
      const resolved = await resolvePluginLoadRequest({
        path: plugin.path,
        trust: plugin.trust,
        configFilePath: configPath,
      });
      results.push({
        level: "PASS",
        label: `plugin:${plugin.path}`,
        detail: `Plugin resolves to ${resolved.resolvedPath} with trust ${resolved.trust}.`,
      });
    } catch (error) {
      results.push({
        level: "FAIL",
        label: `plugin:${plugin.path}`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (config.plugins.length === 0) {
    results.push({
      level: "PASS",
      label: "plugins",
      detail: "No local plugins are configured.",
    });
  }

  return results;
}

function collectPathChecks(
  config: ResolvedAgentConfig,
  configPath: string,
): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];
  const configDirectory = dirname(resolve(configPath));

  if (config.session?.enabled && config.session.dir) {
    results.push({
      level: "PASS",
      label: "session",
      detail: `Session data will be stored under ${resolve(configDirectory, config.session.dir)}.`,
    });
  }

  if (config.audit?.enabled && config.audit.file) {
    results.push({
      level: "PASS",
      label: "audit",
      detail: `Audit log will be written to ${resolve(configDirectory, config.audit.file)}.`,
    });
  }

  if (!config.session?.enabled) {
    results.push({
      level: "WARN",
      label: "session",
      detail: "Session persistence is disabled. Enable session storage if you want resume and recovery.",
    });
  }

  if (!config.audit?.enabled) {
    results.push({
      level: "WARN",
      label: "audit",
      detail: "Audit logging is disabled. Enable audit for stronger traceability.",
    });
  }

  return results;
}

async function runOnlineProbe(
  config: ResolvedAgentConfig,
  configPath: string,
  fetchProbe?: (config: ResolvedAgentConfig) => Promise<void>,
): Promise<void> {
  if (fetchProbe) {
    await fetchProbe(config);
    return;
  }

  const providerRegistry = registerBuiltinProviders(new ProviderRegistry(), config.providerAliases);
  if (config.customProviderModule !== undefined) {
    await loadCustomProviderModule({
      modulePath: config.customProviderModule,
      configFilePath: configPath,
      registry: providerRegistry,
    });
  }
  for (const provider of Object.values(config.customProviders)) {
    await loadCustomProviderModule({
      modulePath: provider.module,
      configFilePath: configPath,
      registry: providerRegistry,
    });
  }

  const { adapter, selection } = providerRegistry.createFromConfig(config);
  await adapter.generate({
    modelId: selection.model.model,
    messages: [{ role: "user", content: "ping" }],
    tools: [],
  }, {});
}
