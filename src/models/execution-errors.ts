import type { RuntimeError } from "../core/types.js";

interface NormalizeModelErrorInput {
  readonly provider: string;
  readonly error: unknown;
  readonly status?: number;
  readonly providerRequestId?: string;
  readonly retryAfterMs?: number;
}

export class ModelExecutionError extends Error {
  constructor(public readonly details: RuntimeError) {
    super(details.message, { cause: details.cause });
    this.name = "ModelExecutionError";
  }
}

export class ToolExecutionError extends Error {
  constructor(public readonly details: RuntimeError) {
    super(details.message, { cause: details.cause });
    this.name = "ToolExecutionError";
  }
}

export function normalizeModelError(input: NormalizeModelErrorInput): ModelExecutionError {
  const { provider, error, status, providerRequestId, retryAfterMs } = input;
  if (error instanceof ModelExecutionError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const base = {
    provider,
    retryable: false,
    message,
    cause: error,
    ...(status !== undefined ? { status } : {}),
    ...(providerRequestId !== undefined ? { providerRequestId } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };

  if (isAbortLikeError(error)) {
    return new ModelExecutionError({
      ...base,
      code: message.toLowerCase().includes("timeout") ? "timeout" : "cancelled",
    });
  }

  if (typeof status === "number") {
    if (status === 401 || status === 403) {
      return new ModelExecutionError({
        ...base,
        code: "auth_error",
      });
    }
    if (status === 429) {
      return new ModelExecutionError({
        ...base,
        code: message.toLowerCase().includes("quota") ? "quota_error" : "rate_limit",
        retryable: true,
      });
    }
    if (status >= 500) {
      return new ModelExecutionError({
        ...base,
        code: "server_error",
        retryable: true,
      });
    }
    if (status === 400) {
      return new ModelExecutionError({
        ...base,
        code: "invalid_request",
      });
    }
  }

  const lowered = message.toLowerCase();
  if (lowered.includes("context")) {
    return new ModelExecutionError({
      ...base,
      code: "context_limit",
    });
  }
  if (lowered.includes("content filter") || lowered.includes("safety")) {
    return new ModelExecutionError({
      ...base,
      code: "content_filter",
    });
  }
  if (lowered.includes("invalid response") || lowered.includes("invalid json") || lowered.includes("malformed")) {
    return new ModelExecutionError({
      ...base,
      code: "invalid_response",
    });
  }

  return new ModelExecutionError({
    ...base,
    code: "network_error",
    retryable: true,
  });
}

export function normalizeToolError(error: unknown, timeout = false): ToolExecutionError {
  const message = error instanceof Error ? error.message : String(error);
  if (timeout) {
    return new ToolExecutionError({
      code: "timeout",
      retryable: false,
      message,
      cause: error,
    });
  }
  if (isAbortLikeError(error)) {
    return new ToolExecutionError({
      code: "cancelled",
      retryable: false,
      message,
      cause: error,
    });
  }
  return new ToolExecutionError({
    code: "invalid_response",
    retryable: false,
    message,
    cause: error,
  });
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  return error instanceof Error && (
    error.name === "AbortError"
    || error.name === "TimeoutError"
    || error.message.toLowerCase().includes("aborted")
    || error.message.toLowerCase().includes("timeout")
  );
}
