import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const ciWorkflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const releaseWorkflowPath = new URL("../.github/workflows/release.yml", import.meta.url);

describe("CI workflow policy", () => {
  it("keeps platform coverage explicit in the main matrix workflow", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");

    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("Type-check source and tests");
    expect(workflow).toContain("Run fast tests");
    expect(workflow).toContain("Build package");
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).not.toContain("if: false");
  });

  it("keeps the package smoke and pack dry-run checks in the release gate", async () => {
    const workflow = await readFile(releaseWorkflowPath, "utf8");

    expect(workflow).toContain("Run package smoke");
    expect(workflow).toContain("Dry-run package contents");
    expect(workflow).toContain("pnpm test:smoke");
    expect(workflow).toContain("pnpm pack:dry-run");
  });
});
