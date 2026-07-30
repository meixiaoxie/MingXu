import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const packageRoot = resolve(process.cwd());
const distDir = resolve(packageRoot, "dist");
const sourceDir = resolve(packageRoot, "src");
const repoRoot = resolve(packageRoot, "..", "..");
const aliasInternalWorkspacePackages = {
  name: "alias-internal-workspace-packages",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^@mingxu\/tui$/ }, () => ({
      path: resolve(repoRoot, "packages", "tui", "src", "index.ts"),
    }));
    buildContext.onResolve({ filter: /^@mingxu\/plugin-sdk$/ }, () => ({
      path: resolve(repoRoot, "packages", "plugin-sdk", "src", "index.ts"),
    }));
  },
};

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await build({
  entryPoints: [
    resolve(sourceDir, "index.ts"),
    resolve(sourceDir, "entry.ts"),
  ],
  outdir: distDir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node22"],
  sourcemap: true,
  plugins: [aliasInternalWorkspacePackages],
  packages: "external",
  absWorkingDir: repoRoot,
  logLevel: "info",
  tsconfig: resolve(repoRoot, "tsconfig.json"),
});
