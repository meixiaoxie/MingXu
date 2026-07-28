const SECRET_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "token",
  "password",
  "secret",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-goog-api-key",
]);

const TEXT_PATTERNS = [
  /(Bearer\s+)[^\s"']+/giu,
  /([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[:=]\s*)[^\s,;"']+/giu,
];

export function redactText(value: string): string {
  return TEXT_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "$1[REDACTED]"),
    value,
  );
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const normalized = key.toLowerCase();
      if (SECRET_KEYS.has(normalized)) {
        return [key, "[REDACTED]"];
      }
      return [key, redactValue(entry)];
    }),
  );
}
