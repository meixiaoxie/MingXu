import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { PluginLoader } from "../src/plugins/plugin-loader.js";
import { JsonlSessionStore } from "../src/session/jsonl-session-store.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { Tool } from "../src/core/types.js";
import { createCodingToolsPlugin, codingToolsManifest } from "../packages/coding-tools/runtime.js";
import type { PreparedToolMutation } from "@mingxu/plugin-sdk";

const roots: string[] = [];
const codingToolsPackageRoot = join(process.cwd(), "packages", "coding-tools");
const expectedToolNames = ["command", "edit", "list", "read", "search", "write"];

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface CodingRuntimeTool {
  execute(input: unknown, context?: { signal?: AbortSignal }): Promise<unknown>;
  prepare?(input: unknown, context?: { signal?: AbortSignal }): Promise<PreparedToolMutation>;
  commit?(preparation: PreparedToolMutation, context?: { signal?: AbortSignal }): Promise<unknown>;
}

async function setupCodingToolsPlugin(workspaceRoot: string): Promise<Map<string, CodingRuntimeTool>> {
  const plugin = createCodingToolsPlugin({ workspaceRoot });
  const tools = new Map<string, CodingRuntimeTool>();
  await plugin.setup({
    registerTool(tool) {
      tools.set(tool.name, tool as unknown as CodingRuntimeTool);
    },
    unregisterTool() {
      return true;
    },
  });
  await expect(plugin.healthCheck?.()).resolves.toBe(true);
  expect(plugin.manifest).toBe(codingToolsManifest);
  expect([...tools.keys()].sort()).toEqual(expectedToolNames);
  return tools;
}

async function createSampleWorkspace(): Promise<string> {
  const root = await createTempRoot("mingxu-coding-tools-workspace-");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, ".secret.txt"), "secret\n", "utf8");
  await writeFile(join(root, "nested", "needle.txt"), "needle found\n", "utf8");
  await writeFile(join(root, "existing.txt"), "alpha\nbeta\n", "utf8");
  return root;
}

const nestedNeedlePath = join("nested", "needle.txt");

async function copyCodingToolsPackage(root: string): Promise<string> {
  const packageRoot = join(root, "coding-tools-package");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(join(packageRoot, "src"), { recursive: true });

  for (const relativePath of [
    "index.js",
    "runtime.js",
    "runtime.d.ts",
    "mingxu.plugin.json",
    "package.json",
    "src/index.ts",
    "src/manifest.ts",
  ]) {
    const source = await readFile(join(codingToolsPackageRoot, relativePath), "utf8");
    await writeFile(join(packageRoot, relativePath), source, "utf8");
  }

  return packageRoot;
}

describe("coding-tools plugin runtime", () => {
  it("exposes workspace-scoped file tools and honors hidden paths", async () => {
    const workspaceRoot = await createSampleWorkspace();
    const tools = await setupCodingToolsPlugin(workspaceRoot);

    const readResult = await tools.get("read")!.execute({
      path: ".secret.txt",
    });
    expect(readResult).toMatchObject({
      kind: "text",
      path: ".secret.txt",
      content: "secret\n",
    });

    const listResult = await tools.get("list")!.execute({
      path: ".",
      recursive: true,
    });
    expect(listResult).toMatchObject({
      kind: "tree",
      path: ".",
    });
    expect((listResult as { entries: Array<{ path: string }> }).entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([".secret.txt", "existing.txt", nestedNeedlePath]),
    );

    const searchResult = await tools.get("search")!.execute({
      path: ".",
      pattern: "needle",
      recursive: true,
    });
    expect(searchResult).toMatchObject({
      kind: "table",
      path: ".",
      count: 1,
    });
    expect((searchResult as { matches: Array<{ path: string }> }).matches[0]?.path).toBe(nestedNeedlePath);

    await expect(tools.get("read")!.execute({ path: "../outside.txt" })).rejects.toThrow("path traversal");
    await expect(tools.get("read")!.execute({ path: "//server/share.txt" })).rejects.toThrow("network path");
  });

  it("previews writes and edits before committing diff results", async () => {
    const workspaceRoot = await createSampleWorkspace();
    const tools = await setupCodingToolsPlugin(workspaceRoot);

    const writeTool = tools.get("write")!;
    const writePreparation = await writeTool.prepare!({
      path: "new-file.txt",
      content: "one\ntwo\n",
    });
    expect(writePreparation).toMatchObject({
      protocol: "mingxu/tool-mutation-v1",
      binding: { operation: "write", baselineHash: "missing" },
      summary: { path: "new-file.txt", afterBytes: 8 },
      presentation: { kind: "diff" },
    });
    expect((writePreparation.presentation.payload as { changes: string[] }).changes.join("\n")).toContain("+ one");
    await expect(readFile(join(workspaceRoot, "new-file.txt"), "utf8")).rejects.toThrow();
    const writeResult = await writeTool.commit!(writePreparation);
    expect(writeResult).toMatchObject({ kind: "diff", operation: "write", path: "new-file.txt", committed: true });
    await expect(readFile(join(workspaceRoot, "new-file.txt"), "utf8")).resolves.toBe("one\ntwo\n");
    await expect(writeTool.execute({ path: "bypass.txt", content: "no" })).rejects.toThrow("prepare/commit");

    const editTool = tools.get("edit")!;
    const editPreparation = await editTool.prepare!({
      path: "existing.txt",
      content: "alpha\nbeta\ngamma\n",
    });
    expect((editPreparation.presentation.payload as { changes: string[] }).changes.join("\n")).toContain("+ gamma");
    await expect(readFile(join(workspaceRoot, "existing.txt"), "utf8")).resolves.toBe("alpha\nbeta\n");
    const editResult = await editTool.commit!(editPreparation);
    expect(editResult).toMatchObject({ kind: "diff", operation: "edit", path: "existing.txt", committed: true });
    await expect(readFile(join(workspaceRoot, "existing.txt"), "utf8")).resolves.toBe("alpha\nbeta\ngamma\n");
  });

  it("runs commands with separated stdout and stderr and truncates output safely", async () => {
    const workspaceRoot = await createSampleWorkspace();
    const tools = await setupCodingToolsPlugin(workspaceRoot);

    const success = await tools.get("command")!.execute({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('hello'); process.stderr.write('world');",
      ],
      cwd: ".",
      maxOutputBytes: 1024,
    });
    expect(success).toMatchObject({
      kind: "command",
      exitCode: 0,
      stdout: "hello",
      stderr: "world",
      truncated: false,
      timedOut: false,
    });

    const truncated = await tools.get("command")!.execute({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1000);",
      ],
      cwd: ".",
      maxOutputBytes: 32,
      timeoutMs: 2000,
    });
    expect(truncated).toMatchObject({
      kind: "command",
      truncated: true,
      timedOut: false,
    });
    expect((truncated as { exitCode: number }).exitCode).not.toBe(0);
    expect((truncated as { stdout: string }).stdout.length).toBeGreaterThan(0);
  });
});

describe("coding-tools extension lifecycle", () => {
  it("installs, enables, loads, disables, and removes the real package", async () => {
    const root = await createTempRoot("mingxu-coding-tools-extension-");
    const sourceRoot = await copyCodingToolsPackage(root);
    const userRoot = join(root, "user");
    const projectRoot = join(root, "project");
    const manager = new ExtensionManager({
      userRoot,
      projectRoot,
      projectTrusted: true,
    });

    const inspected = await manager.inspect(sourceRoot);
    expect(inspected.manifest.id).toBe("mingxu-coding-tools");
    expect(inspected.entryPath.endsWith("index.js")).toBe(true);

    const installed = await manager.install({
      source: sourceRoot,
      scope: "user",
      yes: true,
    });
    expect(installed.record.enabled).toBe(false);
    expect(await manager.list("user")).toHaveLength(1);

    const registry = new ToolRegistry();
    const loader = new PluginLoader({
      registerTool(tool) {
        registry.register(tool as Tool);
      },
      unregisterTool(name) {
        return registry.unregister(name);
      },
    });

    expect(await manager.loadEnabledExtensions(loader, "user")).toEqual([]);

    await manager.enable("mingxu-coding-tools", "user");
    const enabledLock = await manager.inspectLock("user");
    expect(enabledLock.records[0]?.enabled).toBe(true);

    const loaded = await manager.loadEnabledExtensions(loader, "user");
    expect(loaded).toEqual(["mingxu-coding-tools"]);
    expect(registry.list().map((tool) => tool.name).sort()).toEqual(expectedToolNames);

    const sessionStore = new JsonlSessionStore(join(root, "sessions"));
    const session = await sessionStore.createSession({ sessionId: "existing-session" });
    await sessionStore.saveSession(session, session.revision);

    const doctor = await manager.doctor();
    expect(doctor).toContain("mingxu-coding-tools");
    expect(doctor).toContain("healthy");

    await manager.disable("mingxu-coding-tools", "user");
    expect(registry.list()).toEqual([]);
    expect(loader.list()).toEqual([]);
    const afterDisableLoaderTools: string[] = [];
    const afterDisableLoader = new PluginLoader({
      registerTool(tool) {
        afterDisableLoaderTools.push(tool.name);
      },
      unregisterTool() {
        return true;
      },
    });
    expect(await manager.loadEnabledExtensions(afterDisableLoader, "user")).toEqual([]);

    await expect(manager.remove("mingxu-coding-tools", "user")).resolves.toBe(true);
    expect(registry.list()).toEqual([]);
    await expect(sessionStore.getRequiredSession("existing-session")).resolves.toMatchObject({
      session: { sessionId: "existing-session" },
    });
    expect(await manager.list("user")).toEqual([]);
    expect((await manager.inspectLock("user")).records).toEqual([]);
    await expect(readFile(join(userRoot, "extensions", "mingxu-coding-tools", "index.js"), "utf8")).rejects.toThrow();
  });
});
