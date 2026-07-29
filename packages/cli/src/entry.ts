#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { main } from "../../../src/cli/main.js";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: unknown };
const version = typeof manifest.version === "string" ? manifest.version : "development";
const exitCode = await main(process.argv.slice(2), { version });
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
