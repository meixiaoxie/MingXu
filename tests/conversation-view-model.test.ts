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

  it("keeps completed blocks stable when duplicate or stale updates arrive", () => {
    const view = new ConversationViewModel();
    view.startAssistantMessage("assistant-1");
    view.updateAssistantMessage("assistant-1", "A longer answer");
    view.finishAssistantMessage("assistant-1", "A longer answer");
    const block = view.getBlock("assistant-1");
    const revision = block?.revision;

    view.startAssistantMessage("assistant-1");
    view.updateAssistantMessage("assistant-1", "A");
    view.finishAssistantMessage("assistant-1", "A");

    expect(view.getBlock("assistant-1")).toBe(block);
    expect(block?.state).toBe("complete");
    expect(block?.summary).toBe("A longer answer");
    expect(block?.revision).toBe(revision);
  });

  it("does not reopen a completed tool block for a late update", () => {
    const view = new ConversationViewModel();
    const toolCall = { id: "tool-1", name: "read-file", input: { path: "README.md" } };
    view.startToolMessage("tool-1", toolCall);
    view.finishToolMessage("tool-1", toolCall, {
      toolCallId: "tool-1",
      name: "read-file",
      output: "done",
      isError: false,
    });
    const block = view.getBlock("tool-1");
    const revision = block?.revision;

    view.updateToolMessage("tool-1", "late preview");

    expect(view.getBlock("tool-1")).toBe(block);
    expect(block?.state).toBe("complete");
    expect(block?.revision).toBe(revision);
  });

  it("commits only a consecutive completed prefix", () => {
    const view = new ConversationViewModel();
    const toolCall = { id: "tool-1", name: "read-file", input: { path: "README.md" } };
    view.startAssistantMessage("assistant-1");
    view.updateAssistantMessage("assistant-1", "still streaming");
    view.startToolMessage("tool-1", toolCall);
    view.finishToolMessage("tool-1", toolCall, {
      toolCallId: "tool-1",
      name: "read-file",
      output: "done",
      isError: false,
    });

    const blocked = view.prepareRender(80, {}, { full: false });
    expect(blocked.commitPrefixLineCount).toBe(0);
    blocked.commit();
    expect(view.committedBlockCount).toBe(0);
    expect(view.activeBlockCount).toBe(2);

    view.finishAssistantMessage("assistant-1", "finished");
    const ready = view.prepareRender(80, {}, { full: false });
    expect(ready.commitPrefixLineCount).toBeGreaterThan(0);
    ready.commit();
    expect(view.committedBlockCount).toBe(2);
    expect(view.activeBlockCount).toBe(0);
  });
});
