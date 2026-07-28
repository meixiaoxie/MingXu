import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AuditWriter } from "./audit-writer.js";
import type { AuditPolicy } from "./audit-policy.js";
import type { RuntimeEventEnvelope } from "../events/event-envelope.js";

export class JsonlAuditWriter implements AuditWriter {
  readonly #filePath: string;
  readonly #policy: AuditPolicy;
  #healthy = true;
  #operation: Promise<void> = Promise.resolve();

  constructor(filePath: string, policy: AuditPolicy = {}) {
    this.#filePath = resolve(filePath);
    this.#policy = policy;
  }

  async emit(event: RuntimeEventEnvelope): Promise<void> {
    await this.write(event);
  }

  async write(event: RuntimeEventEnvelope): Promise<void> {
    await this.#run(async () => {
      await mkdir(dirname(this.#filePath), { recursive: true });
      const current = await this.#readExisting();
      const nextLine = `${JSON.stringify(event)}\n`;
      const nextContent = `${current}${nextLine}`;
      if (this.#policy.maxBytes !== undefined && Buffer.byteLength(nextContent, "utf8") > this.#policy.maxBytes) {
        await this.#rotate();
      }
      const refreshed = await this.#readExisting();
      await writeFile(this.#filePath, `${refreshed}${nextLine}`, "utf8");
      await this.#enforceRetention();
    }).catch((error) => {
      this.#healthy = false;
      throw error;
    });
  }

  async flush(): Promise<void> {
    await this.#operation;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  isHealthy(): boolean {
    return this.#healthy;
  }

  async #run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async #readExisting(): Promise<string> {
    try {
      return await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  async #rotate(): Promise<void> {
    const rotatedPath = `${this.#filePath}.${Date.now()}`;
    try {
      await rename(this.#filePath, rotatedPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  async #enforceRetention(): Promise<void> {
    if (this.#policy.maxFiles === undefined || this.#policy.maxFiles < 1) {
      return;
    }
    const directory = dirname(this.#filePath);
    const filename = this.#filePath.split(/[/\\]/u).pop() ?? this.#filePath;
    const entries = await readFileDirectory(directory, filename);
    const rotated = entries.filter((entry) => entry !== filename).sort();
    while (rotated.length > this.#policy.maxFiles) {
      const oldest = rotated.shift();
      if (!oldest) break;
      await rm(resolve(directory, oldest), { force: true });
    }
  }
}

async function readFileDirectory(directory: string, prefix: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory);
  return entries.filter((entry) => entry === prefix || entry.startsWith(`${prefix}.`));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
