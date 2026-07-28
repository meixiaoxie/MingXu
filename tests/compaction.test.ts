import { describe, expect, it } from "vitest";
import {
  shouldCompact,
  findCutPoint,
  compactMessages,
  DEFAULT_COMPACTION_SETTINGS,
} from "../src/index.js";
import type { AgentMessage, CompactionSettings } from "../src/index.js";

function makeMessages(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: "user" as const,
    content: "x".repeat(1000), // ~250 tokens each
    createdAt: new Date().toISOString(),
  }));
}

describe("compaction", () => {
  const smallSettings: CompactionSettings = {
    enabled: true,
    maxContextTokens: 2000,
    reserveTokens: 500,
    keepRecentTokens: 500,
  };

  it("超阈值时 shouldCompact 返回 true", () => {
    const messages = makeMessages(10); // ~2500 tokens
    expect(shouldCompact(messages, smallSettings)).toBe(true);
  });

  it("disabled 时不压缩", () => {
    const messages = makeMessages(10);
    expect(
      shouldCompact(messages, { ...smallSettings, enabled: false }),
    ).toBe(false);
  });

  it("找切分点时保留最近尾巴", () => {
    const messages = makeMessages(10);
    const { archived, retained } = findCutPoint(messages, smallSettings);
    expect(archived.length).toBeGreaterThan(0);
    expect(retained.length).toBeGreaterThan(0);
    expect(archived.length + retained.length).toBe(10);
  });

  it("压缩后返回 summary + retained", async () => {
    const messages = makeMessages(10);
    const result = await compactMessages(
      messages,
      smallSettings,
      async () => "Summary of earlier conversation",
    );

    expect(result.didCompact).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messages[0]!.role).toBe("summary");
    expect(result.archivedIds.length).toBeGreaterThan(0);
  });

  it("不超阈值时返回原消息", async () => {
    const messages = makeMessages(2);
    const result = await compactMessages(messages, smallSettings, async () => "summary");

    expect(result.didCompact).toBe(false);
    expect(result.messages).toEqual(messages);
  });
});
