import { mkdtemp, readFile, rm, stat, writeFile, mkdir, access, readdir, rename, symlink } from "node:fs/promises";
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
function runNode(args: readonly string[], cwd = projectRoot): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      shell: false,
      env: { ...process.env, NO_COLOR: "1", npm_config_cache: npmCacheDirectory },
    });
    let stdout = "";
    let stderr = "";

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

function runCommand(command: string, args: readonly string[], cwd = projectRoot): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: { ...process.env, NO_COLOR: "1", npm_config_cache: npmCacheDirectory },
    });
    let stdout = "";
    let stderr = "";

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
  const unpackRoot = await mkdtemp(join(tmpdir(), "mingxu-package-unpack-"));
  const nodeModulesRoot = join(installRoot, "node_modules");
  const packageParentRoot = join(nodeModulesRoot, "@mingxu");
  const packageRoot = join(packageParentRoot, "cli");
  const binRoot = join(installRoot, "node_modules", ".bin");
  const sourceNodeModules = join(projectRoot, "node_modules");
  const extractResult = await runCommand("tar", ["-xzf", tarballPath, "-C", unpackRoot], projectRoot);
  expect(extractResult.exitCode, extractResult.stderr).toBe(0);

  await mkdir(packageParentRoot, { recursive: true });
  await mkdir(nodeModulesRoot, { recursive: true });
  await mkdir(binRoot, { recursive: true });
  await mirrorNodeModules(sourceNodeModules, nodeModulesRoot);
  await rename(join(unpackRoot, "package"), packageRoot);

  if (process.platform === "win32") {
    const cmdPath = join(binRoot, "mingxu.cmd");
    await writeFile(
      cmdPath,
      [
        "@echo off",
        "setlocal",
        `set "_node=${process.execPath}"`,
        "\"%_node%\" \"%~dp0..\\@mingxu\\cli\\dist\\entry.js\" %*",
        "",
      ].join("\r\n"),
      "utf8",
    );
  } else {
    await symlink(join("..", "@mingxu", "cli", "dist", "entry.js"), join(binRoot, "mingxu"));
  }
}

async function mirrorNodeModules(sourceRoot: string, targetRoot: string): Promise<void> {
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "@mingxu") {
      continue;
    }
    const sourcePath = join(sourceRoot, entry.name);
    const targetPath = join(targetRoot, entry.name);
    await symlink(sourcePath, targetPath, process.platform === "win32" ? "junction" : undefined);
  }
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

  // Create a real tarball, then install it into an empty project. This catches
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
    const entryPath = join(installDirectory, "node_modules", "@mingxu", "cli", "dist", "entry.js");
    const entrySource = await readFile(entryPath, "utf8");
    const entryStats = await stat(entryPath);

    // npm must create a platform-specific command link, while the target needs
    // a Unix shebang. Running the target with Node avoids shell differences.
    const binName = process.platform === "win32" ? "mingxu.cmd" : "mingxu";
    const binPath = join(installDirectory, "node_modules", ".bin", binName);
    expect((await stat(binPath)).isFile()).toBe(true);
    expect(entrySource.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(entryStats.isFile()).toBe(true);

    const helpResult = await runCommand(
      process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : binPath,
      process.platform === "win32" ? ["/d", "/s", "/c", binPath, "--help"] : ["--help"],
      installDirectory,
    );
    expect(helpResult.exitCode, helpResult.stderr).toBe(0);
    expect(helpResult.stdout).toContain("Usage: mingxu");
    expect(helpResult.stdout).toContain("--model <name>");
    expect(helpResult.stdout).toContain("--force");
    expect(helpResult.stderr).toBe("");

    const versionResult = await runCommand(
      process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : binPath,
      process.platform === "win32" ? ["/d", "/s", "/c", binPath, "--version"] : ["--version"],
      installDirectory,
    );
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

    const initResult = await runCommand(
      process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : join(installDirectory, "node_modules", ".bin", "mingxu"),
      process.platform === "win32"
        ? ["/d", "/s", "/c", join(installDirectory, "node_modules", ".bin", "mingxu.cmd"), "init", "--config", configPath, "--profile", "secure-local"]
        : ["init", "--config", configPath, "--profile", "secure-local"],
      installDirectory,
    );
    expect(initResult.exitCode, initResult.stderr).toBe(0);
    expect(await readFile(configPath, "utf8")).toContain('"defaultModel": "primary"');

    const sessionDirectory = join(fixtureRoot, ".mingxu", "sessions");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "session-keep.jsonl"), "{\"sessionId\":\"session-keep\"}\n", "utf8");

    const forceResult = await runCommand(
      process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : join(installDirectory, "node_modules", ".bin", "mingxu"),
      process.platform === "win32"
        ? ["/d", "/s", "/c", join(installDirectory, "node_modules", ".bin", "mingxu.cmd"), "init", "--config", configPath, "--profile", "minimal", "--force"]
        : ["init", "--config", configPath, "--profile", "minimal", "--force"],
      installDirectory,
    );
    expect(forceResult.exitCode, forceResult.stderr).toBe(0);
    const rootEntries = await readdir(fixtureRoot);
    const backupName = rootEntries.find((name) => name.startsWith("mingxu.config.json.bak-"));
    expect(backupName).toBeDefined();
    expect(await readFile(join(fixtureRoot, backupName!), "utf8")).toContain('"audit":');
    expect(await readdir(sessionDirectory)).toContain("session-keep.jsonl");

    await writeFile(configPath, JSON.stringify(runConfig, null, 2), "utf8");
    await writeFile(providerModulePath, providerModuleSource, "utf8");

    const runResult = await runCommand(
      process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : join(installDirectory, "node_modules", ".bin", "mingxu"),
      process.platform === "win32"
        ? ["/d", "/s", "/c", join(installDirectory, "node_modules", ".bin", "mingxu.cmd"), "--config", configPath, "Say hello"]
        : ["--config", configPath, "Say hello"],
      installDirectory,
    );
    expect(runResult.exitCode, runResult.stderr).toBe(0);
    expect(runResult.stdout.trim()).toBe("final:Say hello");

    const doctorResult = await runCommand(
      process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : join(installDirectory, "node_modules", ".bin", "mingxu"),
      process.platform === "win32"
        ? ["/d", "/s", "/c", join(installDirectory, "node_modules", ".bin", "mingxu.cmd"), "doctor", "--config", configPath]
        : ["doctor", "--config", configPath],
      installDirectory,
    );
    expect(doctorResult.exitCode, doctorResult.stdout).toBe(0);
    expect(doctorResult.stdout).toContain("PASS config");
    expect(doctorResult.stdout).toContain("PASS plugin");

    const auditPath = join(fixtureRoot, ".mingxu", "audit", "runtime.jsonl");
    const sessionFiles = await readdir(sessionDirectory);
    expect(sessionFiles.length).toBeGreaterThan(0);
    const sessionFilename = sessionFiles.find((name) => name.endsWith(".jsonl"));
    expect(sessionFilename).toBeDefined();
    const sessionId = sessionFilename!.slice(0, -".jsonl".length);
    const resumeResult = await runCommand(
      process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : join(installDirectory, "node_modules", ".bin", "mingxu"),
      process.platform === "win32"
        ? ["/d", "/s", "/c", join(installDirectory, "node_modules", ".bin", "mingxu.cmd"), "--config", configPath, "resume", sessionId, "--prompt", "Continue work"]
        : ["--config", configPath, "resume", sessionId, "--prompt", "Continue work"],
      installDirectory,
    );
    expect(resumeResult.exitCode, resumeResult.stderr).toBe(0);
    expect(resumeResult.stdout.trim()).toBe("final:Say hello|Continue work");

    const sessionSource = await readFile(join(sessionDirectory, sessionFilename!), "utf8");
    expect(sessionSource).toContain("Say hello");
    expect(sessionSource).toContain("Continue work");
    const auditSource = await readFile(auditPath, "utf8");
    expect(auditSource).toContain("run.start");
    expect(auditSource).toContain("run.end");
    expect(auditSource).toContain("model.request.start");
  });
});
