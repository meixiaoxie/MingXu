import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

async function readText(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

describe("extension package skeletons", () => {
  it("keeps plugin-sdk as a standalone protocol package", async () => {
    await expect(stat(join(root, "packages", "plugin-sdk", "package.json"))).resolves.toMatchObject({ size: expect.any(Number) });
    const source = await readText("packages/plugin-sdk/src/protocol.ts");
    expect(source).toContain("export const PLUGIN_API_VERSION = \"mingxu/plugin-v1\"");
    expect(source).toContain("export interface PluginManifestV1");
    expect(source).toContain("export interface PresentationBlock");
    expect(source).toContain("export interface ToolGovernance");
    expect(source).toContain("export interface ExtensionAdapterV1");
  });

  it("keeps coding-tools as an independent optional plugin package", async () => {
    await expect(stat(join(root, "packages", "coding-tools", "mingxu.plugin.json"))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(join(root, "packages", "coding-tools", "index.js"))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(join(root, "packages", "coding-tools", "runtime.js"))).resolves.toMatchObject({ size: expect.any(Number) });
    const packageJson = JSON.parse(await readText("packages/coding-tools/package.json")) as { readonly description?: string; readonly files?: string[] };
    const manifest = await readText("packages/coding-tools/src/manifest.ts");
    const entry = await readText("packages/coding-tools/src/index.ts");
    const runtime = await readText("packages/coding-tools/runtime.js");
    expect(packageJson.description).toBe("Standalone official MingXu coding tools plugin.");
    expect(packageJson.files).toContain("runtime.js");
    expect(manifest).toContain("codingToolsManifest");
    expect(entry).toContain("createCodingToolsPlugin");
    expect(entry).toContain("codingToolsPlugin");
    expect(runtime).toContain("mingxu-coding-tools");
    expect(runtime).toContain('entry: "index.js"');
    expect(runtime).toContain("command requires argv");
    expect(runtime).toContain("maxOutputBytes");
  });

  it("creates the web-search package skeleton for future adapters", async () => {
    await expect(stat(join(root, "packages", "web-search", "mingxu.plugin.json"))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(join(root, "packages", "web-search", "index.js"))).resolves.toMatchObject({ size: expect.any(Number) });
    const packageJson = JSON.parse(await readText("packages/web-search/package.json")) as { readonly name?: string };
    const manifest = await readText("packages/web-search/src/manifest.ts");
    const entry = await readText("packages/web-search/src/index.ts");
    expect(packageJson.name).toBe("@mingxu/web-search");
    expect(manifest).toContain("mingxu-web-search");
    expect(manifest).toContain("web_search");
    expect(entry).toContain("createWebSearchPluginSkeleton");
    expect(entry).toContain("webSearchPluginSkeleton");
  });
});
