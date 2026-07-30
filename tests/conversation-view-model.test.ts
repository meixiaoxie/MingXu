import { describe, expect, it } from "vitest";

import { ConversationViewModel } from "../src/cli/conversation-view-model.js";
import { resolveTranscriptTheme } from "../src/cli/transcript-theme.js";

describe("ConversationViewModel", () => {
  it("renders compact semantic blocks and hides the default run result", () => {
    const view = new ConversationViewModel();
    view.setEmptyHint(["No messages yet."]);
    view.pushUserMessage("user-1", "Hello");
    view.startAssistantMessage("assistant-1");
    view.updateAssistantMessage("assistant-1", "Draft");
    view.updateAssistantMessage("assistant-1", "Final answer");
    view.finishAssistantMessage("assistant-1", "Final answer");
    view.startToolMessage("tool-1", { id: "tool-1", name: "read-file", input: { path: "README.md" } });
    view.finishToolMessage("tool-1", { id: "tool-1", name: "read-file", input: { path: "README.md" } }, {
      toolCallId: "tool-1",
      name: "read-file",
      output: "done",
      isError: false,
      truncated: false,
    });
    view.addStatus("status-1", "run", ["termination: completed", "inputTokens: 1"]);
    view.addApprovalResult("approval-1", {
      toolName: "readFile",
      toolCallId: "approval-tool",
      principalId: "local-user",
      requestFingerprint: "fingerprint",
      actionKind: "tool.call",
      resourceScope: "file",
      reason: "need approval",
      input: { path: "README.md" },
      policyEffect: "ask",
    }, {
      decision: "allow",
      scope: "session",
    });

    const rendered = view.render(80, { theme: resolveTranscriptTheme({ plain: true }) }).join("\n");
    expect(rendered).toContain("Final answer");
    expect(rendered.match(/Final answer/g) ?? []).toHaveLength(1);
    expect(rendered).toContain("read-file: done");
    expect(rendered).toContain("readFile approval: allow (session)");
    expect(rendered).not.toContain("termination:");
    expect(rendered).not.toContain("inputTokens:");
    expect(rendered).not.toContain("\u001b[");
  });
});
