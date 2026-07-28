import { redactValue } from "../redaction/redactor.js";

export interface ProviderDebugSink {
  write(message: string): void;
}

export interface ProviderDebugOptions {
  readonly enabled: boolean;
  readonly sink?: ProviderDebugSink;
}

export interface ProviderDebugLogger {
  readonly enabled: boolean;
  log(scope: string, payload: unknown): void;
}

/**
 * Emits provider diagnostics only when explicitly enabled.
 *
 * All payloads go through the shared redactor so the CLI can show config and
 * request shapes without leaking real credentials into stderr.
 */
export function createProviderDebugLogger(options: ProviderDebugOptions): ProviderDebugLogger {
  return {
    enabled: options.enabled,
    log(scope, payload) {
      if (!options.enabled || !options.sink) {
        return;
      }
      const safePayload = redactValue(payload);
      options.sink.write(`[provider-debug] ${scope} ${JSON.stringify(safePayload)}\n`);
    },
  };
}
