import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { defineTool, type RuntimeTool } from "../tool.js";

const readFileInputSchema = z.object({
  path: z.string().trim().min(1),
  encoding: z.enum(["utf8", "utf-8"]).optional(),
}).strict();

type ReadFileInput = z.infer<typeof readFileInputSchema>;

export interface ReadFileToolOptions {
  readonly rootDirectory?: string;
  readonly maxBytes?: number;
}

/** Creates a text-file reader restricted to one root directory and a bounded file size. */
export function createReadFileTool(
  options: ReadFileToolOptions = {},
): RuntimeTool<ReadFileInput, string> {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const maxBytes = options.maxBytes ?? 1_048_576;

  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("readFile maxBytes must be a positive integer");
  }

  return defineTool({
    name: "readFile",
    description: "Read a UTF-8 text file inside the configured root directory.",
    inputSchema: readFileInputSchema,
    async execute({ path, encoding = "utf8" }) {
      const requestedPath = resolve(rootDirectory, path);
      assertPathInsideRoot(rootDirectory, requestedPath, path);

      // realpath resolves symbolic links. Checking again afterwards prevents a
      // link inside the root from secretly pointing to a file outside it.
      const [realRoot, realFile] = await Promise.all([
        realpath(rootDirectory),
        realpath(requestedPath),
      ]);
      assertPathInsideRoot(realRoot, realFile, path);

      const fileStat = await stat(realFile);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${path}`);
      }
      if (fileStat.size > maxBytes) {
        throw new Error(`File exceeds the ${maxBytes}-byte limit: ${path}`);
      }

      return readFile(realFile, { encoding });
    },
  });
}

/** A safe relative path is empty (the root itself) or does not climb above it. */
function assertPathInsideRoot(root: string, filePath: string, inputPath: string): void {
  const pathFromRoot = relative(root, filePath);
  if (
    pathFromRoot === ".."
    || pathFromRoot.startsWith(`..${sep}`)
    || isAbsolute(pathFromRoot)
  ) {
    throw new Error(`File is outside the allowed root: ${inputPath}`);
  }
}

export const readFileTool = createReadFileTool();
