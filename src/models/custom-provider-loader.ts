import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ProviderRegistry } from "./provider-registry.js";

interface ImportedCustomProviderModule {
  readonly default?: unknown;
  readonly register?: unknown;
}

export type CustomProviderRegister = (
  registry: ProviderRegistry,
) => void | Promise<void>;

export interface LoadCustomProviderModuleOptions {
  /** The module path from the custom provider configuration. */
  readonly modulePath: string;
  /** The config file path; relative module paths are anchored beside this file. */
  readonly configFilePath: string;
  readonly registry: ProviderRegistry;
}

/** Resolves a custom provider path relative to its config file, never the process cwd. */
export function resolveCustomProviderModulePath(
  modulePath: string,
  configFilePath: string,
): string {
  const trimmedModulePath = modulePath.trim();
  const trimmedConfigPath = configFilePath.trim();
  if (!trimmedModulePath) {
    throw new Error("Custom provider module path cannot be empty");
  }
  if (!trimmedConfigPath) {
    throw new Error("Config file path cannot be empty");
  }

  const resolvedConfigPath = resolve(trimmedConfigPath);
  return isAbsolute(trimmedModulePath)
    ? resolve(trimmedModulePath)
    : resolve(dirname(resolvedConfigPath), trimmedModulePath);
}

/** Imports one local provider module and lets its register function extend the registry. */
export async function loadCustomProviderModule(
  options: LoadCustomProviderModuleOptions,
): Promise<void> {
  const resolvedModulePath = resolveCustomProviderModulePath(
    options.modulePath,
    options.configFilePath,
  );

  let imported: ImportedCustomProviderModule;
  try {
    imported = await import(pathToFileURL(resolvedModulePath).href) as ImportedCustomProviderModule;
  } catch (error) {
    throw new Error(
      `Unable to import custom provider module: ${resolvedModulePath}`,
      { cause: error },
    );
  }

  // Supporting default and named `register` exports preserves one simple module
  // protocol while allowing either common ESM authoring style.
  const register = typeof imported.default === "function"
    ? imported.default
    : imported.register;
  if (typeof register !== "function") {
    throw new Error(
      `Invalid custom provider module: ${resolvedModulePath}; `
      + "export a register function as default or named \"register\"",
    );
  }

  try {
    await (register as CustomProviderRegister)(options.registry);
  } catch (error) {
    throw new Error(
      `Custom provider registration failed: ${resolvedModulePath}`,
      { cause: error },
    );
  }
}
