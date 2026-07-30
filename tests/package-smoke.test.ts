import { mkdtemp, readFile, rm, stat, writeFile, mkdir, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const cliPackageRoot = join(projectRoot, "packages", "cli");
let installDirectory = "";

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
      env: { ...process.env, NO_COLOR: "1" },
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
      env: { ...process.env, NO_COLOR: "1" },
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

async function resolveNpmCommand(): Promise<{ readonly command: string; readonly args: readonly string[] }> {
  const bundledNpmCliPath = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  try {
    await access(bundledNpmCliPath);
    return { command: process.execPath, args: [bundledNpmCliPath] };
  } catch {
    // Fall through to package resolution and platform launchers.
  }

  try {
    const npmCliPath = createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
    await access(npmCliPath);
    return { command: process.execPath, args: [npmCliPath] };
  } catch {
    const directFallback = process.platform === "win32"
      ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd"] }
      : { command: "npm", args: [] as string[] };
    const directProbe = await runCommand(
      directFallback.command,
      [...directFallback.args, "--version"],
      projectRoot,
    ).catch(() => undefined);
    if (directProbe?.exitCode === 0) {
      return directFallback;
    }

    const corepackProbe = await runCommand("corepack", ["npm", "--version"], projectRoot).catch(() => undefined);
    if (corepackProbe?.exitCode === 0) {
      return { command: "corepack", args: ["npm"] };
    }

    throw new Error(
      "Unable to locate npm for package smoke. Install npm or expose it on PATH before running pnpm test:smoke.",
    );
  }
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
  const npmCommand = await resolveNpmCommand();
  const packed = await runCommand(
    npmCommand.command,
    [...npmCommand.args, "pack", "--json", "--pack-destination", packDirectory],
    cliPackageRoot,
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
  const installed = await runCommand(
    npmCommand.command,
    [...npmCommand.args, "install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    installDirectory,
  );
  expect(installed.exitCode, installed.stderr).toBe(0);
}, 180_000);

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

    const helpResult = await runNode([entryPath, "--help"], installDirectory);
    expect(helpResult.exitCode, helpResult.stderr).toBe(0);
    expect(helpResult.stdout).toContain("Usage: mingxu");
    expect(helpResult.stdout).toContain("--model <name>");
    expect(helpResult.stderr).toBe("");

    const versionResult = await runNode([entryPath, "--version"], installDirectory);
    expect(versionResult.exitCode, versionResult.stderr).toBe(0);
    expect(versionResult.stdout.trim()).toBe("0.4.0");
  }, 20_000);

  it("completes an offline init -> run -> doctor -> audit loop from the packed tarball", async () => {
    const fixtureRoot = join(installDirectory, "offline-e2e-fixture");
    const entryPath = join(installDirectory, "node_modules", "@mingxu", "cli", "dist", "entry.js");
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

    const initResult = await runNode([entryPath, "init", "--config", configPath, "--profile", "secure-local"], installDirectory);
    expect(initResult.exitCode, initResult.stderr).toBe(0);
    expect(await readFile(configPath, "utf8")).toContain('"defaultModel": "primary"');

    await writeFile(configPath, JSON.stringify(runConfig, null, 2), "utf8");
    await writeFile(providerModulePath, providerModuleSource, "utf8");

    const runResult = await runNode([entryPath, "--config", configPath, "Say hello"], fixtureRoot);
    expect(runResult.exitCode, runResult.stderr).toBe(0);
    expect(runResult.stdout.trim()).toBe("final:Say hello");

    const doctorResult = await runNode([entryPath, "doctor", "--config", configPath], fixtureRoot);
    expect(doctorResult.exitCode, doctorResult.stdout).toBe(0);
    expect(doctorResult.stdout).toContain("PASS config");
    expect(doctorResult.stdout).toContain("PASS plugin");

    const sessionDirectory = join(fixtureRoot, ".mingxu", "sessions");
    const auditPath = join(fixtureRoot, ".mingxu", "audit", "runtime.jsonl");
    const sessionFiles = await readdir(sessionDirectory);
    expect(sessionFiles.length).toBeGreaterThan(0);
    const sessionFilename = sessionFiles.find((name) => name.endsWith(".jsonl"));
    expect(sessionFilename).toBeDefined();
    const sessionId = sessionFilename!.slice(0, -".jsonl".length);
    const resumeResult = await runNode([
      entryPath,
      "--config",
      configPath,
      "resume",
      sessionId,
      "--prompt",
      "Continue work",
    ], fixtureRoot);
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
