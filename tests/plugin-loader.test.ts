import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, afterEach, vi } from "vitest";

import { PluginLoader, resolvePluginLoadRequest } from "../src/plugins/plugin-loader.js";

interface RegisteredTool {
  readonly name: string;
}

const loadedRoots: string[] = [];

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  loadedRoots.push(root);
  return root;
}

async function writePluginModule(root: string, relativePath: string, source: string): Promise<string> {
  const modulePath = join(root, relativePath);
  await mkdir(join(modulePath, ".."), { recursive: true });
  await writeFile(modulePath, source, "utf8");
  return modulePath;
}

afterEach(async () => {
  await Promise.all(loadedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PluginLoader", () => {
  it("deactivates, unregisters, and disposes a loaded plugin", async () => {
    const registeredTools: RegisteredTool[] = [];
    const deactivate = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const loader = new PluginLoader({
      registerTool(tool) {
        registeredTools.push(tool as RegisteredTool);
      },
      unregisterTool(name) {
        const index = registeredTools.findIndex((tool) => tool.name === name);
        if (index < 0) return false;
        registeredTools.splice(index, 1);
        return true;
      },
    });
    await loader.load({
      name: "lifecycle-plugin",
      manifest: {
        apiVersion: "mingxu/plugin-v1",
        id: "lifecycle-id",
        name: "Lifecycle",
        version: "1.0.0",
        kind: "tool",
        contributions: [],
      },
      setup(context) {
        context.registerTool({ name: "lifecycle-tool", description: "test", inputSchema: {} });
      },
      deactivate,
      dispose,
    });

    await expect(loader.unload("lifecycle-id")).resolves.toBe(true);
    expect(deactivate).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(registeredTools).toEqual([]);
    expect(loader.list()).toEqual([]);
    await expect(loader.unload("lifecycle-id")).resolves.toBe(false);
  });

  it("loads a valid local plugin and exposes it in the registry", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-");
    const modulePath = await writePluginModule(root, "valid-plugin.mjs", `
      export default {
        name: "valid-plugin",
        manifest: { name: "valid-plugin", version: "1.0.0", kind: "tool" },
        async setup(context) {
          context.registerTool({ name: "echo-extra" });
        },
      };
    `);
    const registeredTools: RegisteredTool[] = [];
    const loader = new PluginLoader({
      registerTool(tool) {
        registeredTools.push(tool as RegisteredTool);
      },
      unregisterTool(name) {
        const index = registeredTools.findIndex((tool) => tool.name === name);
        if (index >= 0) {
          registeredTools.splice(index, 1);
          return true;
        }
        return false;
      },
    });

    const plugin = await loader.load(modulePath);

    expect(plugin.name).toBe("valid-plugin");
    expect(loader.list().map((loaded) => loaded.name)).toEqual(["valid-plugin"]);
    expect(registeredTools.map((tool) => tool.name)).toEqual(["echo-extra"]);
  });

  it("resolves relative plugin paths from the config file directory", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-");
    const configRoot = join(root, "config");
    const pluginsRoot = join(root, "plugins");
    const modulePath = await writePluginModule(pluginsRoot, "scoped-plugin.mjs", `
      export default {
        name: "scoped-plugin",
        manifest: { name: "scoped-plugin", version: "1.0.0", kind: "tool" },
        async setup() {},
      };
    `);
    const configPath = join(configRoot, "mingxu.config.json");
    await mkdir(configRoot, { recursive: true });
    await writeFile(configPath, "{}", "utf8");

    const resolved = await resolvePluginLoadRequest({
      path: "../plugins/scoped-plugin.mjs",
      configFilePath: configPath,
      trust: "trusted_local",
      kind: "tool",
      manifest: "scoped-plugin",
    });

    expect(resolved.resolvedPath).toBe(modulePath);
  });

  it("accepts local file URLs while preserving local-only validation", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-");
    const modulePath = await writePluginModule(root, "file-url-plugin.mjs", `
      export default {
        name: "file-url-plugin",
        manifest: { name: "file-url-plugin", version: "1.0.0", kind: "tool" },
        async setup() {},
      };
    `);

    const resolved = await resolvePluginLoadRequest({
      path: pathToFileURL(modulePath).href,
      trust: "trusted_local",
      kind: "tool",
      manifest: "file-url-plugin",
    });

    expect(fileURLToPath(pathToFileURL(modulePath))).toBe(resolved.resolvedPath);
    expect(resolved.sourceKind).toBe("file_url");
  });

  it("rejects blocked plugins before importing third-party code", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-");
    const modulePath = await writePluginModule(root, "blocked-plugin.mjs", `
      throw new Error("should not import blocked plugin");
    `);
    const loader = new PluginLoader({ registerTool() {} });

    await expect(loader.load({ path: modulePath, trust: "blocked" })).rejects.toThrow(
      `Plugin is blocked by configuration: ${modulePath}`,
    );
    expect(loader.list()).toEqual([]);
  });

  it("rejects duplicate plugin names without leaving duplicate registrations", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-");
    const firstPath = await writePluginModule(root, "first.mjs", `
      export default {
        name: "duplicate-plugin",
        manifest: { name: "duplicate-plugin", version: "1.0.0", kind: "tool" },
        async setup() {},
      };
    `);
    const secondPath = await writePluginModule(root, "second.mjs", `
      export default {
        name: "duplicate-plugin",
        manifest: { name: "duplicate-plugin", version: "1.0.0", kind: "tool" },
        async setup() {},
      };
    `);
    const loader = new PluginLoader({ registerTool() {} });

    await loader.load(firstPath);
    await expect(loader.load(secondPath)).rejects.toThrow("Plugin already loaded: duplicate-plugin");
    expect(loader.list().map((plugin) => plugin.name)).toEqual(["duplicate-plugin"]);
  });

  it("accepts non-tool manifest kinds as plugin metadata", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-");
    const modulePath = await writePluginModule(root, "preset-plugin.mjs", `
      export default {
        name: "preset-plugin",
        manifest: { name: "preset-plugin", version: "1.0.0", kind: "preset" },
        async setup() {},
      };
    `);
    const loader = new PluginLoader({ registerTool() {} });

    await expect(loader.load({ path: modulePath, kind: "preset", manifest: "preset-plugin" })).resolves.toMatchObject({
      name: "preset-plugin",
    });
    expect(loader.list().map((plugin) => plugin.name)).toEqual(["preset-plugin"]);
  });

  it("propagates setup failures without leaving a half-registered plugin", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-");
    const modulePath = await writePluginModule(root, "broken-setup.mjs", `
      export default {
        name: "broken-setup",
        manifest: { name: "broken-setup", version: "1.0.0", kind: "tool" },
        async setup() {
          throw new Error("setup failed");
        },
      };
    `);
    const loader = new PluginLoader({ registerTool() {} });

    await expect(loader.load(modulePath)).rejects.toThrow("setup failed");
    expect(loader.list()).toEqual([]);
  });

  it("rolls back tools registered before setup failure", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-");
    const modulePath = await writePluginModule(root, "rollback-plugin.mjs", `
      export default {
        name: "rollback-plugin",
        manifest: { name: "rollback-plugin", version: "1.0.0", kind: "tool" },
        async setup(context) {
          context.registerTool({ name: "tool-a" });
          throw new Error("setup failed after tool registration");
        },
      };
    `);
    const registeredTools: RegisteredTool[] = [];
    const loader = new PluginLoader({
      registerTool(tool) {
        registeredTools.push(tool as RegisteredTool);
      },
      unregisterTool(name) {
        const index = registeredTools.findIndex((tool) => tool.name === name);
        if (index >= 0) {
          registeredTools.splice(index, 1);
          return true;
        }
        return false;
      },
    });

    await expect(loader.load(modulePath)).rejects.toThrow("setup failed after tool registration");
    expect(registeredTools).toEqual([]);
    expect(loader.list()).toEqual([]);
  });

  it("rolls back previously registered tools when a later tool registration fails", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-");
    const modulePath = await writePluginModule(root, "duplicate-tool-plugin.mjs", `
      export default {
        name: "duplicate-tool-plugin",
        manifest: { name: "duplicate-tool-plugin", version: "1.0.0", kind: "tool" },
        async setup(context) {
          context.registerTool({ name: "tool-a" });
          context.registerTool({ name: "tool-a" });
        },
      };
    `);
    const registeredTools: RegisteredTool[] = [];
    const loader = new PluginLoader({
      registerTool(tool) {
        const duplicate = registeredTools.some((registered) => registered.name === tool.name);
        if (duplicate) {
          throw new Error(`Tool already registered: ${tool.name}`);
        }
        registeredTools.push(tool as RegisteredTool);
      },
      unregisterTool(name) {
        const index = registeredTools.findIndex((tool) => tool.name === name);
        if (index >= 0) {
          registeredTools.splice(index, 1);
          return true;
        }
        return false;
      },
    });

    await expect(loader.load(modulePath)).rejects.toThrow("Tool already registered: tool-a");
    expect(registeredTools).toEqual([]);
    expect(loader.list()).toEqual([]);
  });

  it("rejects unsupported plugin extensions", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-");
    const modulePath = await writePluginModule(root, "plugin.txt", "not a module");
    const loader = new PluginLoader({ registerTool() {} });

    await expect(loader.load(modulePath)).rejects.toThrow(
      "Plugin path must reference a JavaScript module, a package directory, or a tarball",
    );
  });

  it("rejects remote URLs and network-share paths", async () => {
    const loader = new PluginLoader({ registerTool() {} });

    await expect(loader.load("https://example.com/plugin.mjs")).rejects.toThrow(
      "Plugin path must be a local filesystem path or file URL",
    );
    await expect(loader.load("//server/share/plugin.mjs")).rejects.toThrow(
      "Plugin path must reference a local file, not a network share",
    );
  });

  it("rejects missing files", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-");
    const loader = new PluginLoader({ registerTool() {} });

    await expect(loader.load(join(root, "missing-plugin.mjs"))).rejects.toThrow(
      "Plugin file does not exist",
    );
  });

  it("rejects modules without a valid default or named plugin export", async () => {
    const root = await createTempRoot("mingxu-plugin-loader-");
    const modulePath = await writePluginModule(root, "invalid-export.mjs", `
      export const somethingElse = { name: "wrong" };
    `);
    const loader = new PluginLoader({ registerTool() {} });

    await expect(loader.load(modulePath)).rejects.toThrow(
      `Plugin module must export a plugin as default or "plugin": ${modulePath}`,
    );
  });
});
