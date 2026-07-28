import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadCustomProviderModule,
  ProviderRegistry,
  resolveCustomProviderModulePath,
} from "../src/index.js";
import * as modelExports from "../src/models/index.js";

async function writeModule(root: string, source: string): Promise<string> {
  const modulePath = join(root, "custom-provider.mjs");
  await writeFile(modulePath, source, "utf8");
  return modulePath;
}

describe("custom provider module loader", () => {
  it("resolves relative modules beside the config file rather than cwd", () => {
    const configPath = join("root", "nested", "mingxu.config.json");
    expect(resolveCustomProviderModulePath("./providers/custom.mjs", configPath)).toBe(
      resolve("root", "nested", "providers", "custom.mjs"),
    );
  });

  it("imports a named register function and passes the registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-custom-provider-success-"));
    const marker = `registry_${Date.now()}_${Math.random()}`;
    await writeModule(root, `
      export function register(registry) {
        globalThis[${JSON.stringify(marker)}] = registry;
      }
    `);
    const registry = new ProviderRegistry();

    await loadCustomProviderModule({
      modulePath: "./custom-provider.mjs",
      configFilePath: join(root, "mingxu.config.json"),
      registry,
    });

    expect((globalThis as Record<string, unknown>)[marker]).toBe(registry);
    delete (globalThis as Record<string, unknown>)[marker];
  });

  it("supports an asynchronous default register function", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-custom-provider-async-"));
    const marker = `async_${Date.now()}_${Math.random()}`;
    await writeModule(root, `
      export default async function register() {
        await Promise.resolve();
        globalThis[${JSON.stringify(marker)}] = "registered";
      }
    `);

    await loadCustomProviderModule({
      modulePath: "./custom-provider.mjs",
      configFilePath: join(root, "config.json"),
      registry: new ProviderRegistry(),
    });

    expect((globalThis as Record<string, unknown>)[marker]).toBe("registered");
    delete (globalThis as Record<string, unknown>)[marker];
  });

  it("reports missing modules and unsupported exports with their resolved paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-custom-provider-errors-"));
    const missingPath = join(root, "missing.mjs");
    await expect(loadCustomProviderModule({
      modulePath: "./missing.mjs",
      configFilePath: join(root, "config.json"),
      registry: new ProviderRegistry(),
    })).rejects.toThrow(`Unable to import custom provider module: ${missingPath}`);

    const invalidPath = await writeModule(root, "export const value = 1;");
    await expect(loadCustomProviderModule({
      modulePath: invalidPath,
      configFilePath: join(root, "config.json"),
      registry: new ProviderRegistry(),
    })).rejects.toThrow("export a register function as default or named \"register\"");
  });

  it("wraps synchronous and asynchronous registration failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-custom-provider-failure-"));
    const syncPath = await writeModule(root, `
      export function register() { throw new Error("sync exploded"); }
    `);
    const syncPromise = loadCustomProviderModule({
      modulePath: syncPath,
      configFilePath: join(root, "config.json"),
      registry: new ProviderRegistry(),
    });
    await expect(syncPromise).rejects.toHaveProperty("cause.message", "sync exploded");

    const asyncPath = join(root, "async-provider.mjs");
    await writeFile(asyncPath, `
      export async function register() { throw new Error("async exploded"); }
    `, "utf8");
    const asyncPromise = loadCustomProviderModule({
      modulePath: asyncPath,
      configFilePath: join(root, "config.json"),
      registry: new ProviderRegistry(),
    });
    await expect(asyncPromise).rejects.toHaveProperty("cause.message", "async exploded");
  });

  it("exposes loader functions from model and package public entry points", () => {
    expect(modelExports.loadCustomProviderModule).toBe(loadCustomProviderModule);
    expect(modelExports.resolveCustomProviderModulePath).toBe(resolveCustomProviderModulePath);
  });
});
