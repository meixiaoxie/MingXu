import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/session/session-entry.js";
import { buildContextFromEntries } from "../src/context/context-builder.js";
import { createBranchPointEntry } from "../src/context/compaction-cutpoints.js";

describe("branch point context", () => {
  it("treats branch points like cut markers when rebuilding context", () => {
    const entries: SessionEntry[] = [
      {
        id: "m1",
        type: "message",
        sessionId: "s1",
        createdAt: "2026-07-29T00:00:00.000Z",
        message: { id: "u1", role: "user", content: "old", createdAt: "now" },
      },
      createBranchPointEntry({
        id: "b1",
        sessionId: "s1",
        createdAt: "2026-07-29T00:01:00.000Z",
        branchName: "feature",
      }),
      {
        id: "m2",
        type: "message",
        sessionId: "s1",
        createdAt: "2026-07-29T00:02:00.000Z",
        message: { id: "u2", role: "user", content: "new", createdAt: "now" },
      },
    ];

    const context = buildContextFromEntries(entries, "base");
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]!.content).toBe("new");
    expect(context.systemPrompt).toBe("base");
  });
});
