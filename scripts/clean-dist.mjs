import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const distDirectory = resolve(process.cwd(), "dist");

await rm(distDirectory, { recursive: true, force: true });
