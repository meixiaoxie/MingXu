import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { PluginLoader } from "../src/plugins/plugin-loader.js";

const roots: string[] = [];

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeExtensionPackage(root: string): Promise<string> {
  const packageRoot = join(root, "sample-extension");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "mingxu.plugin.json"), JSON.stringify({
    apiVersion: "mingxu/plugin-v1",
    id: "sample-extension",
    name: "sample-extension",
    version: "1.0.0",
    kind: "tool",
    entry: "index.mjs",
    contributions: [{ kind: "tool", name: "sample_tool", description: "Sample tool" }],
  }, null, 2), "utf8");
  await writeFile(join(packageRoot, "index.mjs"), `
    export default {
      name: "sample-extension",
      manifest: {
        apiVersion: "mingxu/plugin-v1",
        id: "sample-extension",
        name: "sample-extension",
        version: "1.0.0",
        kind: "tool",
        entry: "index.mjs",
        contributions: [{ kind: "tool", name: "sample_tool" }],
      },
      async setup(context) {
        context.registerTool({
          name: "sample_tool",
          description: "Sample tool",
          inputSchema: {},
          async execute() {
            return "ok";
          },
        });
      },
    };
  `, "utf8");
  return packageRoot;
}

describe("ExtensionManager", () => {
  it("installs a local extension package and writes a lock file", async () => {
    const root = await createTempRoot("mingxu-extension-manager-");
    const sourceRoot = await writeExtensionPackage(root);
    const manager = new ExtensionManager({
      userRoot: join(root, "user"),
      projectRoot: join(root, "project"),
      projectTrusted: true,
    });

    const inspected = await manager.inspect(sourceRoot);
    expect(inspected.manifest.id).toBe("sample-extension");
    expect(inspected.entryPath.endsWith("index.mjs")).toBe(true);

    const installed = await manager.install({
      source: sourceRoot,
      scope: "user",
      yes: true,
    });

    expect(installed.record.id).toBe("sample-extension");
    expect(installed.record.enabled).toBe(true);
    expect(await manager.list()).toHaveLength(1);

    const lockPath = join(root, "user", "extensions.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { records?: Array<{ id?: string }> };
    expect(lock.records?.[0]?.id).toBe("sample-extension");
  });

  it("loads a directory package through the plugin loader", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-dir-");
    const packageRoot = await writeExtensionPackage(root);
    const tools: string[] = [];
    const loader = new PluginLoader({
      registerTool(tool) {
        tools.push(tool.name);
      },
      unregisterTool(name) {
        const index = tools.indexOf(name);
        if (index >= 0) {
          tools.splice(index, 1);
          return true;
        }
        return false;
      },
    });

    const plugin = await loader.load(packageRoot);

    expect(plugin.name).toBe("sample-extension");
    expect(tools).toContain("sample_tool");
  });
});
