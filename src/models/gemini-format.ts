import type {
  ModelRequest,
  ModelRequestMessage,
  ModelResponse,
  ModelToolCall,
} from "./model-protocol.js";

interface GeminiPart {
  text?: unknown;
  functionCall?: unknown;
}

interface GeminiFunctionCall {
  name?: unknown;
  args?: unknown;
}

interface GeminiCandidate {
  content?: unknown;
  finishReason?: unknown;
}

interface GeminiUsageMetadata {
  promptTokenCount?: unknown;
  candidatesTokenCount?: unknown;
  totalTokenCount?: unknown;
  cachedContentTokenCount?: unknown;
}

interface GeminiResponseShape {
  candidates?: unknown;
  usageMetadata?: unknown;
}

/**
 * Builds the documented Gemini generateContent payload from the neutral model
 * protocol. Provider-specific field names stay here instead of leaking into core.
 */
export function buildGeminiRequest(request: ModelRequest): Record<string, unknown> {
  const systemText = [
    request.system,
    ...request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return {
    ...(systemText.length
      ? { systemInstruction: { parts: [{ text: systemText.join("\n") }] } }
      : {}),
    contents: request.messages
      .filter((message) => message.role !== "system")
      .map(toGeminiContent),
    ...(request.tools?.length
      ? {
          tools: [{
            functionDeclarations: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
          }],
        }
      : {}),
    ...buildGenerationConfig(request),
  };
}

function buildGenerationConfig(request: ModelRequest): Record<string, unknown> {
  const generationConfig = {
    ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.responseFormat === "json"
      ? { responseMimeType: "application/json" }
      : {}),
  };

  return Object.keys(generationConfig).length ? { generationConfig } : {};
}

function toGeminiContent(message: ModelRequestMessage): Record<string, unknown> {
  if (message.role === "tool") {
    if (!message.name) {
      throw new Error("Gemini tool result messages require a tool name");
    }

    return {
      role: "user",
      parts: [{
        functionResponse: {
          name: message.name,
          // Gemini requires an object response, so preserve text and error state
          // under stable keys rather than guessing whether text contains JSON.
          response: {
            output: message.content,
            isError: message.isError ?? false,
          },
        },
      }],
    };
  }

  const parts: Record<string, unknown>[] = message.content
    ? [{ text: message.content }]
    : [];
  if (message.role === "assistant") {
    parts.push(...(message.toolCalls ?? []).map((call) => ({
      functionCall: { name: call.name, args: call.input },
    })));
  }

  // Gemini calls assistant messages "model" messages. Empty text remains an
  // explicit part so every content item is accepted by generateContent.
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: parts.length ? parts : [{ text: "" }],
  };
}

/** Parses the first Gemini candidate into the runtime's neutral response. */
export function parseGeminiResponse(value: unknown): ModelResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Gemini returned an invalid response: expected an object");
  }

  const response = value as GeminiResponseShape;
  if (!Array.isArray(response.candidates) || response.candidates.length === 0) {
    throw new Error("Gemini returned an invalid response: candidates must be a non-empty array");
  }

  const candidate = response.candidates[0] as GeminiCandidate | undefined;
  if (!candidate || !candidate.content || typeof candidate.content !== "object") {
    throw new Error("Gemini returned an invalid response: candidate content is missing");
  }

  const parts = (candidate.content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) {
    throw new Error("Gemini returned an invalid response: candidate parts must be an array");
  }

  const text: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  parts.forEach((rawPart, partIndex) => {
    if (!rawPart || typeof rawPart !== "object") return;
    const part = rawPart as GeminiPart;
    if (typeof part.text === "string") text.push(part.text);
    if (part.functionCall !== undefined) {
      const call = part.functionCall as GeminiFunctionCall | null;
      if (!call || typeof call !== "object" || typeof call.name !== "string" || !call.name) {
        throw new Error("Gemini returned an invalid response: functionCall.name must be a string");
      }
      toolCalls.push({
        // Gemini does not return call IDs. A deterministic local ID lets the
        // agent correlate the following tool result with this response part.
        id: `gemini-call-0-${partIndex}`,
        name: call.name,
        input: call.args ?? {},
      });
    }
  });

  const usage = parseUsage(response.usageMetadata);
  return {
    text: text.join("\n"),
    toolCalls,
    ...(typeof candidate.finishReason === "string"
      ? { stopReason: candidate.finishReason }
      : {}),
    ...(usage ? { usage } : {}),
  };
}

function parseUsage(value: unknown): ModelResponse["usage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as GeminiUsageMetadata;
  const result = {
    ...(typeof usage.promptTokenCount === "number"
      ? { inputTokens: usage.promptTokenCount }
      : {}),
    ...(typeof usage.candidatesTokenCount === "number"
      ? { outputTokens: usage.candidatesTokenCount }
      : {}),
    ...(typeof usage.totalTokenCount === "number"
      ? { totalTokens: usage.totalTokenCount }
      : {}),
    ...(typeof usage.cachedContentTokenCount === "number"
      ? { cacheReadTokens: usage.cachedContentTokenCount }
      : {}),
  };
  return Object.keys(result).length ? result : undefined;
}
