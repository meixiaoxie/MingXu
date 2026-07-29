import { parseSecretRef } from "../redaction/secret-ref.js";

export interface ProviderEnvOptions {
  readonly env?: NodeJS.ProcessEnv;
}

export function readProviderEnv(
  name: string,
  options: ProviderEnvOptions = {},
): string | undefined {
  const value = (options.env ?? process.env)[name];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveProviderSecret(
  value: string | undefined,
  fallbackEnvName: string,
  options: ProviderEnvOptions = {},
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return readProviderEnv(fallbackEnvName, options);
  }

  const secretRef = parseSecretRef(trimmed);
  if (!secretRef) {
    return trimmed;
  }

  return readProviderEnv(secretRef.name, options);
}
