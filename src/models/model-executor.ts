import type { ExecutionSignalScope } from "../core/execution-signal.js";
import { withExecutionSignal } from "../core/execution-signal.js";
import { normalizeModelError } from "./execution-errors.js";
import { retryProviderRequest } from "./provider-retry.js";
import type { ModelConfig } from "../config/config-schema.js";
import { toModelOutput, toModelRequest } from "./request-builder.js";
import type { ModelAdapter } from "./provider-registry.js";
import { createModelEndEvent, createModelErrorEvent, createModelStartEvent } from "./model-events.js";
import type { ModelEvent } from "./model-protocol.js";

export interface ModelExecutorRequest {
  readonly input: import("../core/types.js").ModelInput;
  readonly context?: ExecutionSignalScope;
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

  async *stream(request: ModelExecutorRequest): AsyncIterable<ModelEvent> {
    const signal = withExecutionSignal(request.context ?? {}, request.context?.timeoutMs);
    const modelRequest = toModelRequest(request.input, this.config);

    yield createModelStartEvent(modelRequest);

    if (this.adapter.stream) {
      try {
        const stream = await this.adapter.stream(modelRequest, signal ? { signal } : {});
        for await (const event of stream) {
          if (event.type === "start") continue;
          yield event;
        }
        return;
      } catch (error) {
        yield createModelErrorEvent(error);
        throw normalizeModelError({
          provider: this.adapter.provider,
          error,
        });
      }
    }

    const response = await this.generate(request);
    yield createModelEndEvent({
      text: response.content,
      toolCalls: response.toolCalls,
      ...(response.stopReason !== undefined ? { stopReason: response.stopReason } : {}),
      ...(response.usage !== undefined ? { usage: response.usage } : {}),
      ...(response.refusal !== undefined ? { refusal: response.refusal } : {}),
      ...(response.errors !== undefined ? { errors: response.errors } : {}),
      ...(response.providerRequestId !== undefined ? { rawProviderData: { providerRequestId: response.providerRequestId } } : {}),
    });
  }

  async generate(request: ModelExecutorRequest): Promise<import("../core/types.js").ModelOutput> {
    const signal = withExecutionSignal(request.context ?? {}, request.context?.timeoutMs);
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
