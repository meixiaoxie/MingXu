export interface SseMessageEvent {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

/**
 * Parses a text/event-stream body into discrete SSE messages.
 *
 * The parser is intentionally strict about event framing while still accepting
 * the wire shapes used by OpenAI-compatible, Anthropic, and Gemini streams:
 * - CRLF or LF line endings
 * - multi-line data fields
 * - comments and blank lines
 * - [DONE] sent as a normal data payload
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array> | null | undefined,
  signal?: AbortSignal,
): AsyncGenerator<SseMessageEvent> {
  if (!body) {
    throw new Error("Streaming response is missing a readable body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drainBufferedEvents(buffer, (next) => {
        buffer = next;
      });
    }

    buffer += decoder.decode();
    yield* drainBufferedEvents(buffer, (next) => {
      buffer = next;
    }, true);
  } finally {
    reader.releaseLock();
  }
}

function* drainBufferedEvents(
  buffer: string,
  setBuffer: (value: string) => void,
  flush = false,
): Generator<SseMessageEvent> {
  let working = normalizeLineEndings(buffer);

  while (true) {
    const separatorIndex = working.indexOf("\n\n");
    if (separatorIndex === -1) {
      break;
    }

    const rawEvent = working.slice(0, separatorIndex);
    working = working.slice(separatorIndex + 2);
    const event = parseRawEvent(rawEvent);
    if (event) {
      yield event;
    }
  }

  if (flush) {
    const event = parseRawEvent(working);
    if (event) {
      yield event;
    }
    setBuffer("");
    return;
  }

  setBuffer(working);
}

function parseRawEvent(rawEvent: string): SseMessageEvent | undefined {
  if (!rawEvent.trim()) {
    return undefined;
  }

  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  for (const line of rawEvent.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const value = separatorIndex === -1
      ? ""
      : line.slice(separatorIndex + 1).replace(/^ /u, "");

    switch (field) {
      case "data":
        data.push(value);
        break;
      case "event":
        event = value || undefined;
        break;
      case "id":
        id = value || undefined;
        break;
      case "retry": {
        const parsedRetry = Number.parseInt(value, 10);
        if (Number.isFinite(parsedRetry)) {
          retry = parsedRetry;
        }
        break;
      }
      default:
        break;
    }
  }

  if (data.length === 0 && event === undefined && id === undefined && retry === undefined) {
    return undefined;
  }

  return {
    ...(event !== undefined ? { event } : {}),
    data: data.join("\n"),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}
