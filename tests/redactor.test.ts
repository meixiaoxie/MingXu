import { describe, expect, it } from "vitest";

import { redactText, redactValue } from "../src/redaction/redactor.js";

describe("redactor", () => {
  it("redacts secret-looking fields inside objects", () => {
    expect(redactValue({
      apiKey: "secret-value",
      nested: { authorization: "Bearer super-secret", ok: "safe" },
    })).toEqual({
      apiKey: "[REDACTED]",
      nested: { authorization: "[REDACTED]", ok: "safe" },
    });
  });

  it("redacts secret-looking text fragments", () => {
    expect(redactText("Authorization: Bearer super-secret-token")).toContain("[REDACTED]");
    expect(redactText("API_KEY=super-secret-token")).toContain("[REDACTED]");
  });
});
