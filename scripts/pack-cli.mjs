#!/usr/bin/env node
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageRoot = resolve(repoRoot, "packages", "cli");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const packDestinationIndex = args.indexOf("--pack-destination");
const packDestination = packDestinationIndex >= 0 ? args[packDestinationIndex + 1] : undefined;

const stagingRoot = await mkdtemp(join(tmpdir(), "mingxu-cli-pack-"));
const stagingPackageRoot = join(stagingRoot, "package");
const npmCacheRoot = join(stagingRoot, "npm-cache");
await mkdir(stagingPackageRoot, { recursive: true });
await cp(join(packageRoot, "dist"), join(stagingPackageRoot, "dist"), { recursive: true });

const packageJsonPath = join(packageRoot, "package.json");
const originalPackage = JSON.parse(await readFile(packageJsonPath, "utf8"));
const dependencies = Object.fromEntries(
  Object.entries(originalPackage.dependencies ?? {}).filter(([name]) => !name.startsWith("@mingxu/")),
);
const stagedPackage = {
  name: originalPackage.name,
  version: originalPackage.version,
  type: originalPackage.type,
  description: originalPackage.description,
  bin: originalPackage.bin,
  main: originalPackage.main,
  files: ["dist"],
  dependencies,
};
await writeFile(join(stagingPackageRoot, "package.json"), `${JSON.stringify(stagedPackage, null, 2)}\n`, "utf8");

const npmCliPath = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const child = spawn(process.execPath, [
  npmCliPath,
  "pack",
  "--json",
  ...(dryRun ? ["--dry-run"] : []),
  ...(packDestination ? ["--pack-destination", packDestination] : []),
], {
  cwd: stagingPackageRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, npm_config_cache: npmCacheRoot },
});

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

const exitCode = await new Promise((resolveExit, rejectExit) => {
  child.on("error", rejectExit);
  child.on("close", (code) => resolveExit(code ?? 1));
});

await rm(stagingRoot, { recursive: true, force: true });
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
