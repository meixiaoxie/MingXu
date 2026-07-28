import type { RunContext } from "../core/types.js";
import { withExecutionSignal } from "../core/execution-signal.js";
import { normalizeModelError } from "./execution-errors.js";
import { retryProviderRequest } from "./provider-retry.js";
import type { ModelConfig } from "../config/config-schema.js";
import { toModelOutput, toModelRequest } from "./request-builder.js";
import type { ModelAdapter } from "./provider-registry.js";

export interface ModelExecutorRequest {
  readonly input: import("../core/types.js").ModelInput;
  readonly context: RunContext;
}

/**
 * ModelExecutor becomes the single runtime entry for provider calls.
 * Stage C keeps it intentionally small: one request in, one normalized response out,
 * with metadata preserved for later stages such as retries, budgets, and audit.
 */
export class ModelExecutor {
  constructor(
    private readonly adapter: ModelAdapter,
    private readonly config: ModelConfig,
  ) {}

  async generate(request: ModelExecutorRequest): Promise<import("../core/types.js").ModelOutput> {
    const signal = withExecutionSignal(request.context, request.context.timeoutMs);
    const modelRequest = toModelRequest(request.input, this.config);

    try {
      const response = await retryProviderRequest(
        async () => this.adapter.generate(modelRequest, signal ? { signal } : {}),
        {
          ...(signal ? { signal } : {}),
          shouldRetry: (error) => {
            const status = typeof error === "object" && error !== null && "status" in error
              && typeof (error as { status?: unknown }).status === "number"
              ? (error as { status: number }).status
              : undefined;
            const retryAfterMs = typeof error === "object" && error !== null && "retryAfterMs" in error
              && typeof (error as { retryAfterMs?: unknown }).retryAfterMs === "number"
              ? (error as { retryAfterMs: number }).retryAfterMs
              : undefined;
            const normalized = normalizeModelError({
              provider: this.adapter.provider,
              error,
              ...(status !== undefined ? { status } : {}),
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            });
            return normalized.details.retryable && normalized.details.code !== "cancelled";
          },
          getRetryAfterMs: (error) => {
            const status = typeof error === "object" && error !== null && "status" in error
              && typeof (error as { status?: unknown }).status === "number"
              ? (error as { status: number }).status
              : undefined;
            const retryAfterMs = typeof error === "object" && error !== null && "retryAfterMs" in error
              && typeof (error as { retryAfterMs?: unknown }).retryAfterMs === "number"
              ? (error as { retryAfterMs: number }).retryAfterMs
              : undefined;
            const normalized = normalizeModelError({
              provider: this.adapter.provider,
              error,
              ...(status !== undefined ? { status } : {}),
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            });
            return normalized.details.retryAfterMs;
          },
        },
      );
      return toModelOutput(response, this.adapter.provider);
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        && typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : undefined;
      const retryAfterMs = typeof error === "object" && error !== null && "retryAfterMs" in error
        && typeof (error as { retryAfterMs?: unknown }).retryAfterMs === "number"
        ? (error as { retryAfterMs: number }).retryAfterMs
        : undefined;
      throw normalizeModelError({
        provider: this.adapter.provider,
        error,
        ...(status !== undefined ? { status } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
  }
}
