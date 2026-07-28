import { describe, expect, it } from "vitest";

import { normalizeCommandExec } from "../src/policy/normalizers/command-exec-normalizer.js";

describe("command exec normalizer", () => {
  it("normalizes argv, cwd, env keys, and execution limits", () => {
    const request = normalizeCommandExec({
      toolName: "runCommand",
      argv: ["git", "status"],
      cwd: "D:/repo",
      envKeys: ["PATH", "HOME"],
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      principalId: "local-user",
      interactive: false,
      runId: "run-1",
      iteration: 1,
    });

    expect(request.action).toMatchObject({ kind: "command.exec", mode: "exec" });
    expect(request.resource).toMatchObject({
      kind: "command",
      argv: ["git", "status"],
      cwd: "D:/repo",
      envKeys: ["PATH", "HOME"],
      timeoutMs: 5000,
      maxOutputBytes: 4096,
    });
  });
});
