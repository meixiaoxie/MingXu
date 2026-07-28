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
