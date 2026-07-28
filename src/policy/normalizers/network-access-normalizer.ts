import type { PolicyRequest } from "../types.js";

export interface NetworkAccessNormalizerInput {
  toolName: string;
  url: string;
  principalId: string;
  interactive: boolean;
  runId: string;
  iteration: number;
  toolCallId?: string;
  sessionId?: string;
  traceId?: string;
}

export function normalizeNetworkAccess(input: NetworkAccessNormalizerInput): PolicyRequest {
  const url = new URL(input.url);
  const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
  const host = url.hostname.toLowerCase();
  const isPrivateAddress = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/u.test(host);

  return {
    principal: {
      kind: "user",
      id: input.principalId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    },
    action: {
      kind: "network.request",
      name: input.toolName,
      mode: "connect",
    },
    resource: {
      kind: "network",
      url: input.url,
      scheme: url.protocol.replace(/:$/u, ""),
      host,
      port,
      isPrivateAddress,
    },
    normalizedInput: {
      url: input.url,
      host,
      port,
      scheme: url.protocol.replace(/:$/u, ""),
    },
    runContext: {
      runId: input.runId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      interactive: input.interactive,
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      iteration: input.iteration,
    },
  };
}
