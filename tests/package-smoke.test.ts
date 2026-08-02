import { mkdtemp, readFile, rm, stat, writeFile, mkdir, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const cliPackageRoot = join(projectRoot, "packages", "cli");
let installDirectory = "";
const npmCacheDirectory = join(tmpdir(), `mingxu-package-smoke-cache-${process.pid}`);

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a Node script directly, avoiding shell and PATH differences in CI. */
function runNode(args: readonly string[], cwd = projectRoot, input?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", npm_config_cache: npmCacheDirectory },
    });
    let stdout = "";
    let stderr = "";

    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

function runCommand(command: string, args: readonly string[], cwd = projectRoot, input?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", npm_config_cache: npmCacheDirectory },
    });
    let stdout = "";
    let stderr = "";

    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

function parsePackReports(stdout: string): Array<{
  readonly filename: string;
  readonly files: Array<{ readonly path: string }>;
}> {
  for (const match of stdout.matchAll(/^[\[{]/gmu)) {
    try {
      const parsed: unknown = JSON.parse(stdout.slice(match.index));
      const candidates = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object"
          ? Object.values(parsed)
          : [];
      const reports = candidates.filter((candidate): candidate is {
        readonly filename: string;
        readonly files: Array<{ readonly path: string }>;
      } => Boolean(
        candidate
        && typeof candidate === "object"
        && "filename" in candidate
        && "files" in candidate
        && Array.isArray(candidate.files),
      ));
      if (reports.length > 0) return reports;
    } catch {
      // Continue until a complete trailing JSON document is found.
    }
  }
  throw new Error("npm pack did not emit a usable JSON report");
}

function resolvePnpmCommand(): { readonly command: string; readonly args: readonly string[] } {
  return process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd"] }
    : { command: "pnpm", args: [] };
}

async function installPackedCliTarball(tarballPath: string, installRoot: string): Promise<void> {
  const npmCliPath = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const installed = await runNode([
    npmCliPath,
    "install",
    "--global",
    "--prefix",
    installRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarballPath,
  ], installRoot);
  expect(installed.exitCode, installed.stderr).toBe(0);
}

function installedPackageRoot(): string {
  return process.platform === "win32"
    ? join(installDirectory, "node_modules", "@mingxu", "cli")
    : join(installDirectory, "lib", "node_modules", "@mingxu", "cli");
}

function installedBinPath(): string {
  return process.platform === "win32"
    ? join(installDirectory, "mingxu.cmd")
    : join(installDirectory, "bin", "mingxu");
}

function runInstalledCli(args: readonly string[], cwd = installDirectory, input?: string): Promise<CommandResult> {
  const binPath = installedBinPath();
  return runCommand(
    process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : binPath,
    process.platform === "win32" ? ["/d", "/s", "/c", binPath, ...args] : args,
    cwd,
    input,
  );
}

beforeAll(async () => {
  const staleModule = join(cliPackageRoot, "dist", "stale.js");
  await mkdir(dirname(staleModule), { recursive: true });
  await writeFile(staleModule, "export const stale = true;\n", "utf8");

  // Exercise the package script so stale compiler output cannot survive a build.
  const pnpmCommand = resolvePnpmCommand();
  const build = await runCommand(pnpmCommand.command, [...pnpmCommand.args, "-C", "packages/cli", "build"], projectRoot);
  expect(build.exitCode, build.stderr).toBe(0);
  await expect(access(staleModule)).rejects.toMatchObject({ code: "ENOENT" });

  installDirectory = await mkdtemp(join(tmpdir(), "mingxu-package-smoke-"));
  const packDirectory = join(installDirectory, "packed");
  await mkdir(packDirectory);

  // Create a real tarball, then globally install it under an isolated prefix. This catches
  // missing files, broken package metadata, and unusable executable links.
  const packPnpmCommand = resolvePnpmCommand();
  const packed = await runCommand(
    packPnpmCommand.command,
    [...packPnpmCommand.args, "-C", "packages/cli", "run", "pack:staged", "--", "--pack-destination", packDirectory],
    projectRoot,
  );
  expect(packed.exitCode, packed.stderr).toBe(0);
  const reports = parsePackReports(packed.stdout);
  const report = reports[0];
  expect(report).toBeDefined();
  const paths = report?.files.map((file) => file.path) ?? [];
  expect(paths).toEqual(expect.arrayContaining([
    "dist/index.js",
    "dist/entry.js",
  ]));
  expect(paths).not.toContain("dist/stale.js");

  const tarballPath = join(packDirectory, report?.filename ?? "missing.tgz");
  await installPackedCliTarball(tarballPath, installDirectory);
}, 300_000);

afterAll(async () => {
  if (installDirectory) await rm(installDirectory, { recursive: true, force: true });
});

describe("packed CLI and public API smoke path", () => {
  it("installs a CLI bin that prints help and version", async () => {
    const entryPath = join(installedPackageRoot(), "dist", "entry.js");
    const packageJsonPath = join(installedPackageRoot(), "package.json");
    const entrySource = await readFile(entryPath, "utf8");
    const installedPackage = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      readonly bin?: Record<string, string>;
      readonly files?: string[];
      readonly dependencies?: Record<string, string>;
      readonly private?: boolean;
    };
    const entryStats = await stat(entryPath);

    // npm must create a platform-specific command link, while the target needs
    // a Unix shebang. Running the target with Node avoids shell differences.
    const binPath = installedBinPath();
    expect((await stat(binPath)).isFile()).toBe(true);
    expect(entrySource.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(entryStats.isFile()).toBe(true);
    expect(installedPackage.bin).toMatchObject({ mingxu: "./dist/entry.js" });
    expect(installedPackage.files).toEqual(["dist"]);
    expect(installedPackage.dependencies).toMatchObject({ marked: "^18.0.7" });
    expect(installedPackage.dependencies ?? {}).not.toHaveProperty("@mingxu/tui");
    expect(installedPackage.private).not.toBe(true);

    const helpResult = await runInstalledCli(["--help"]);
    expect(helpResult.exitCode, helpResult.stderr).toBe(0);
    expect(helpResult.stdout).toContain("Usage: mingxu");
    expect(helpResult.stdout).toContain("--model <name>");
    expect(helpResult.stdout).toContain("--force");
    expect(helpResult.stderr).toBe("");

    const versionResult = await runInstalledCli(["--version"]);
    expect(versionResult.exitCode, versionResult.stderr).toBe(0);
    expect(versionResult.stdout.trim()).toBe("0.4.0");
  }, 20_000);

  it("completes an offline init -> run -> doctor -> audit loop from the packed tarball", async () => {
    const fixtureRoot = join(installDirectory, "offline-e2e-fixture");
    const configPath = join(fixtureRoot, "mingxu.config.json");
    const providerModulePath = join(fixtureRoot, "providers.mjs");
    const runConfig = {
      defaultModel: "local",
      models: {
        local: {
          provider: "local-test",
          model: "local-model",
        },
      },
      customProviders: {
        module: "./providers.mjs",
      },
      plugins: [],
      session: {
        enabled: true,
        dir: ".mingxu/sessions",
        save: true,
      },
      audit: {
        enabled: true,
        file: ".mingxu/audit/runtime.jsonl",
      },
    };
    const providerModuleSource = [
      "export function register(registry) {",
      "  registry.register({",
      "    provider: 'local-test',",
      "    capabilities: {",
      "      supportsTools: true,",
      "      supportsStreaming: false,",
      "      supportsImages: false,",
      "      supportsStructuredOutput: false,",
      "      supportsRefusal: false,",
      "      supportsFallback: false,",
      "      supportsEffort: false,",
      "      supportsPromptCaching: false,",
      "      supportsMidConversationSystem: false,",
      "      maxContext: 1000,",
      "      maxOutput: 100,",
      "    },",
      "    create() {",
      "      return {",
      "        provider: 'local-test',",
      "        capabilities: this.capabilities,",
      "        async generate(request) {",
      "          const history = request.messages",
      "            .filter((message) => message.role === 'user')",
      "            .map((message) => message.content)",
      "            .join('|');",
      "          return { text: `final:${history}`, toolCalls: [] };",
      "        },",
      "      };",
      "    },",
      "  });",
      "}",
    ].join("\n");

    await mkdir(fixtureRoot, { recursive: true });

    const initResult = await runInstalledCli(["init", "--config", configPath, "--profile", "secure-local"]);
    expect(initResult.exitCode, initResult.stderr).toBe(0);
    expect(await readFile(configPath, "utf8")).toContain('"defaultModel": "primary"');

    const sessionDirectory = join(fixtureRoot, ".mingxu", "sessions");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "session-keep.jsonl"), "{\"sessionId\":\"session-keep\"}\n", "utf8");

    const forceResult = await runInstalledCli(["init", "--config", configPath, "--profile", "minimal", "--force"]);
    expect(forceResult.exitCode, forceResult.stderr).toBe(0);
    const rootEntries = await readdir(fixtureRoot);
    const backupName = rootEntries.find((name) => name.startsWith("mingxu.config.json.bak-"));
    expect(backupName).toBeDefined();
    expect(await readFile(join(fixtureRoot, backupName!), "utf8")).toContain('"audit":');
    expect(await readdir(sessionDirectory)).toContain("session-keep.jsonl");

    await writeFile(configPath, JSON.stringify(runConfig, null, 2), "utf8");
    await writeFile(providerModulePath, providerModuleSource, "utf8");

    const runResult = await runInstalledCli(["--config", configPath, "Say hello"]);
    expect(runResult.exitCode, runResult.stderr).toBe(0);
    expect(runResult.stdout.trim()).toBe("final:Say hello");

    const sessionsResult = await runInstalledCli(["sessions", "--config", configPath]);
    expect(sessionsResult.exitCode, sessionsResult.stderr).toBe(0);
    const sessionId = sessionsResult.stdout.trim().split(/\r?\n/u)[0]?.split("\t")[0];
    expect(sessionId).toBeDefined();
    if (!sessionId) {
      throw new Error("Expected a recent session id from the packed CLI");
    }

    const auditPath = join(fixtureRoot, ".mingxu", "audit", "runtime.jsonl");
    const resumeResult = await runInstalledCli(["--config", configPath, "resume", sessionId, "--prompt", "Continue work"]);
    expect(resumeResult.exitCode, resumeResult.stderr).toBe(0);
    expect(resumeResult.stdout.trim()).toBe("final:Say hello|Continue work");

    const auditSource = await readFile(auditPath, "utf8");
    expect(auditSource).toContain("run.start");
    expect(auditSource).toContain("run.end");
    expect(auditSource).toContain("model.request.start");

    const continueFixtureRoot = join(installDirectory, "continue-e2e-fixture");
    const continueConfigPath = join(continueFixtureRoot, "mingxu.config.json");
    const continueProviderPath = join(continueFixtureRoot, "providers.mjs");
    await mkdir(continueFixtureRoot, { recursive: true });
    await writeFile(continueConfigPath, JSON.stringify(runConfig, null, 2), "utf8");
    await writeFile(continueProviderPath, providerModuleSource, "utf8");

    const continueSeedResult = await runInstalledCli(["--config", continueConfigPath, "Say hello"]);
    expect(continueSeedResult.exitCode, continueSeedResult.stderr).toBe(0);
    expect(continueSeedResult.stdout.trim()).toBe("final:Say hello");

    const continueResult = await runInstalledCli(["--config", continueConfigPath, "--continue"], continueFixtureRoot, "Continue work\n");
    expect(continueResult.exitCode, continueResult.stderr).toBe(0);
    expect(continueResult.stdout.trim()).toBe("final:Say hello|Continue work");

    const chatResult = await runInstalledCli(["--config", configPath, "chat"], fixtureRoot, "Direct chat prompt\n");
    expect(chatResult.exitCode, chatResult.stderr).toBe(0);
    expect(chatResult.stdout.trim()).toBe("final:Direct chat prompt");

    const doctorResult = await runInstalledCli(["doctor", "--config", configPath]);
    expect(doctorResult.exitCode, doctorResult.stdout).toBe(0);
    expect(doctorResult.stdout).toContain("PASS config");
    expect(doctorResult.stdout).toContain("PASS plugin");

    const extensionRoot = join(fixtureRoot, "extensions", "smoke-extension");
    const extensionTarget = join("extensions", "smoke-extension");
    const skeletonResult = await runInstalledCli(["extensions", "init", extensionTarget, "smoke-extension"], fixtureRoot);
    expect(skeletonResult.exitCode, skeletonResult.stderr).toBe(0);
    expect(await readFile(join(extensionRoot, "mingxu.plugin.json"), "utf8")).toContain('"id": "smoke-extension"');

    const addResult = await runInstalledCli(["--config", configPath, "extensions", "add", extensionTarget, "--scope", "project", "--yes"], fixtureRoot);
    expect(addResult.exitCode, addResult.stderr).toBe(0);
    expect(addResult.stdout).toContain("Installed smoke-extension");

    const listResult = await runInstalledCli(["--config", configPath, "extensions", "list", "--scope", "project"]);
    expect(listResult.exitCode, listResult.stderr).toBe(0);
    expect(listResult.stdout).toContain("smoke-extension");
    expect(listResult.stdout).toContain("disabled");

    const doctorExtensionsResult = await runInstalledCli(["--config", configPath, "extensions", "doctor", "--scope", "project"]);
    expect(doctorExtensionsResult.exitCode, doctorExtensionsResult.stderr).toBe(0);
    expect(doctorExtensionsResult.stdout).toContain("health: healthy");

    const disableResult = await runInstalledCli(["--config", configPath, "extensions", "disable", "smoke-extension", "--scope", "project"]);
    expect(disableResult.exitCode, disableResult.stderr).toBe(0);
    expect(disableResult.stdout).toContain("disabled smoke-extension");

    const enableResult = await runInstalledCli(["--config", configPath, "extensions", "enable", "smoke-extension", "--scope", "project"]);
    expect(enableResult.exitCode, enableResult.stderr).toBe(0);
    expect(enableResult.stdout).toContain("enabled smoke-extension");

    const disableAgainResult = await runInstalledCli(["--config", configPath, "extensions", "disable", "smoke-extension", "--scope", "project"]);
    expect(disableAgainResult.exitCode, disableAgainResult.stderr).toBe(0);
    expect(disableAgainResult.stdout).toContain("disabled smoke-extension");

    const removeResult = await runInstalledCli(["--config", configPath, "extensions", "remove", "smoke-extension", "--scope", "project"]);
    expect(removeResult.exitCode, removeResult.stderr).toBe(0);
    expect(removeResult.stdout).toContain("removed smoke-extension");

    const emptyListResult = await runInstalledCli(["--config", configPath, "extensions", "list", "--scope", "project"]);
    expect(emptyListResult.exitCode, emptyListResult.stderr).toBe(0);
    expect(emptyListResult.stdout).toContain("No extensions are installed.");
  }, 300_000);
});
