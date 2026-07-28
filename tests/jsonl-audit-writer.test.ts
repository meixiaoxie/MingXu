import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { JsonlAuditWriter } from "../src/audit/jsonl-audit-writer.js";
import { createRuntimeEvent } from "../src/events/runtime-events.js";

describe("JsonlAuditWriter", () => {
  it("writes one JSON object per line", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-audit-"));
    const filePath = join(root, "audit.jsonl");
    const writer = new JsonlAuditWriter(filePath);

    try {
      await writer.write(createRuntimeEvent("run.start", { hello: "world" }, {
        runId: "run-1",
        sequence: 1,
        source: "core",
      }));
      await writer.write(createRuntimeEvent("run.end", { status: "ok" }, {
        runId: "run-1",
        sequence: 2,
        source: "core",
      }));
      await writer.flush();

      const content = await readFile(filePath, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ eventType: "run.start" });
      expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ eventType: "run.end" });
    } finally {
      await writer.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
