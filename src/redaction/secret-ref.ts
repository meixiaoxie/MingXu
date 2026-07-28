export interface SecretRef {
  kind: "env";
  name: string;
}

export function parseSecretRef(value: string): SecretRef | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("env:")) return undefined;
  const name = trimmed.slice(4).trim();
  if (!name) {
    throw new Error("env secretRef must include an environment variable name");
  }
  return { kind: "env", name };
}
