import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceRoot = resolve(process.cwd());
const targets = [resolve(workspaceRoot, "dist")];

try {
  for (const entry of await readdir(resolve(workspaceRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    targets.push(resolve(workspaceRoot, "packages", entry.name, "dist"));
  }
} catch {
  // The workspace packages directory may not exist during bootstrap.
}

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
}
