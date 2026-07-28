import { redactValue } from "./redactor.js";

export function safeSerialize(value: unknown): string {
  const redacted = redactValue(value);
  try {
    return JSON.stringify(redacted);
  } catch {
    return String(redacted);
  }
}
