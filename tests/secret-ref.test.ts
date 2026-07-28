import { describe, expect, it } from "vitest";

import { parseSecretRef } from "../src/redaction/secret-ref.js";

describe("secret-ref", () => {
  it("parses env secret references", () => {
    expect(parseSecretRef("env:OPENAI_API_KEY")).toEqual({ kind: "env", name: "OPENAI_API_KEY" });
    expect(parseSecretRef("plain-text")).toBeUndefined();
  });

  it("rejects empty env secret references", () => {
    expect(() => parseSecretRef("env:   ")).toThrow("env secretRef must include an environment variable name");
  });
});
