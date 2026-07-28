import { describe, expect, it } from "vitest";

import { normalizeNetworkAccess } from "../src/policy/normalizers/network-access-normalizer.js";

describe("network access normalizer", () => {
  it("normalizes host, port, scheme, and private-address posture", () => {
    const request = normalizeNetworkAccess({
      toolName: "fetchUrl",
      url: "https://api.example.com/v1/items",
      principalId: "local-user",
      interactive: false,
      runId: "run-1",
      iteration: 1,
    });

    expect(request.action).toMatchObject({ kind: "network.request", mode: "connect" });
    expect(request.resource).toMatchObject({
      kind: "network",
      host: "api.example.com",
      port: 443,
      scheme: "https",
      isPrivateAddress: false,
    });
  });

  it("marks localhost/private targets as private", () => {
    const request = normalizeNetworkAccess({
      toolName: "fetchUrl",
      url: "http://127.0.0.1:8080/admin",
      principalId: "local-user",
      interactive: false,
      runId: "run-1",
      iteration: 1,
    });

    expect(request.resource).toMatchObject({
      kind: "network",
      host: "127.0.0.1",
      port: 8080,
      isPrivateAddress: true,
    });
  });
});
