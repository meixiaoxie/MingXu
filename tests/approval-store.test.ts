import { describe, expect, it } from "vitest";

import { InMemoryApprovalStore } from "../src/approval/in-memory-approval-store.js";
import { isApprovalUsable } from "../src/approval/approval-matcher.js";

describe("approval store", () => {
  it("matches usable approval records by fingerprint", async () => {
    const store = new InMemoryApprovalStore();
    await store.add({
      id: "approval-1",
      requestFingerprint: "fp-1",
      principalId: "local-user",
      actionKind: "file.read",
      resourceScope: "D:/repo",
      operator: "local-user",
      decision: "allow",
      createdAt: new Date().toISOString(),
    });

    const record = await store.findMatching("fp-1", "local-user");
    expect(record?.id).toBe("approval-1");
    expect(isApprovalUsable(record)).toBe(true);
  });

  it("ignores revoked or expired approvals", async () => {
    const store = new InMemoryApprovalStore();
    await store.add({
      id: "approval-expired",
      requestFingerprint: "fp-2",
      principalId: "local-user",
      actionKind: "command.exec",
      resourceScope: "git status",
      operator: "local-user",
      decision: "allow",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await store.add({
      id: "approval-revoked",
      requestFingerprint: "fp-3",
      principalId: "local-user",
      actionKind: "command.exec",
      resourceScope: "git status",
      operator: "local-user",
      decision: "allow",
      createdAt: new Date().toISOString(),
      revokedAt: new Date().toISOString(),
    });

    expect(await store.findMatching("fp-2", "local-user")).toBeUndefined();
    expect(await store.findMatching("fp-3", "local-user")).toBeUndefined();
  });

  it("does not reuse an approval across principals", async () => {
    const store = new InMemoryApprovalStore();
    await store.add({
      id: "approval-principal-a",
      requestFingerprint: "fp-shared",
      principalId: "principal-a",
      actionKind: "tool.call",
      resourceScope: "echo",
      operator: "principal-a",
      decision: "allow",
      createdAt: new Date().toISOString(),
    });

    expect(await store.findMatching("fp-shared", "principal-b")).toBeUndefined();
  });
});
