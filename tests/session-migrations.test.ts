import { describe, expect, it } from "vitest";

import { migrateLegacySessionDocument, sessionMigrationRegistry } from "../src/session/index.js";

describe("session migrations", () => {
  it("migrates legacy messages payloads into session/v1 documents", () => {
    const migrated = migrateLegacySessionDocument({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    });

    expect(migrated.schemaVersion).toBe("session/v1");
    expect(migrated.session.sessionId).toBeTruthy();
    expect(migrated.runs[0]?.turns[0]?.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
  });

  it("fails fast on unknown versions", () => {
    expect(() => sessionMigrationRegistry.migrate("session/v999", {})).toThrow("No migration registered for version");
  });
});
