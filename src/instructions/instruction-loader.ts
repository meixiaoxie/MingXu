import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { EventSink } from "../events/event-sink.js";
import { createRuntimeEvent } from "../events/runtime-events.js";
import { assertPathInsideRoot, assertSafeIdentifier, resolveSafeRelativePath } from "../safety/path-safety.js";

export type InstructionScope = "managed" | "user" | "project" | "local" | "session";

export interface InstructionSource {
  readonly scope: InstructionScope;
  readonly name: string;
  readonly priority: number;
  readonly path: string;
  readonly content: string;
}

export interface InstructionRootConfig {
  readonly dir?: string;
  readonly file?: string;
  readonly files?: readonly string[];
}

export interface InstructionLoaderOptions {
  readonly systemPrompt?: string;
  readonly managed?: InstructionRootConfig;
  readonly user?: InstructionRootConfig;
  readonly project?: InstructionRootConfig;
  readonly local?: InstructionRootConfig;
  readonly session?: InstructionRootConfig;
  readonly autoLoadClaudeMd?: boolean;
  readonly maxInstructionBytes?: number;
  readonly maxTotalBytes?: number;
  readonly eventSink?: EventSink;
  readonly runId?: string;
  readonly sessionId?: string;
}

const DEFAULT_MAX_INSTRUCTION_BYTES = 64 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024;
const DEFAULT_FILENAMES = ["MINGXU.md", "CLAUDE.md"] as const;

export class InstructionLoader {
  readonly #options: InstructionLoaderOptions;

  constructor(options: InstructionLoaderOptions = {}) {
    this.#options = options;
  }

  async load(): Promise<InstructionSource[]> {
    const sources: InstructionSource[] = [];
    let totalBytes = 0;

    if (this.#options.systemPrompt?.trim()) {
      const content = this.#options.systemPrompt.trim();
      totalBytes = this.#addBytes(totalBytes, Buffer.byteLength(content, "utf8"));
      sources.push({
        scope: "managed",
        name: "systemPrompt",
        priority: 0,
        path: "system:systemPrompt",
        content,
      });
    }

    for (const entry of await this.#discover("managed", this.#options.managed)) {
      totalBytes = this.#appendSource(sources, entry, totalBytes);
    }
    for (const entry of await this.#discover("user", this.#options.user)) {
      totalBytes = this.#appendSource(sources, entry, totalBytes);
    }
    for (const entry of await this.#discover("project", this.#options.project)) {
      totalBytes = this.#appendSource(sources, entry, totalBytes);
    }
    for (const entry of await this.#discover("local", this.#options.local)) {
      totalBytes = this.#appendSource(sources, entry, totalBytes);
    }
    for (const entry of await this.#discover("session", this.#options.session)) {
      totalBytes = this.#appendSource(sources, entry, totalBytes);
    }

    return sources;
  }

  async build(): Promise<string> {
    const sources = await this.load();
    return sources.map((source) => source.content).join("\n\n---\n\n");
  }

  async discover(): Promise<ReadonlyArray<Omit<InstructionSource, "content">>> {
    return (await this.load()).map(({ content: _content, ...source }) => source);
  }

  async #discover(scope: InstructionScope, config?: InstructionRootConfig): Promise<InstructionSource[]> {
    if (!config) return [];
    const candidates: string[] = [];
    const files = config.files?.length ? config.files : DEFAULT_FILENAMES;

    if (config.file) {
      candidates.push(config.file);
    }

    if (config.dir) {
      for (const fileName of files) {
        if (scope === "managed" && fileName !== "MINGXU.md") continue;
        if (fileName === "CLAUDE.md" && this.#options.autoLoadClaudeMd === false) continue;
        candidates.push(join(config.dir, fileName));
      }
    }

    const discovered: InstructionSource[] = [];
    let priority = this.#priorityForScope(scope);
    for (const candidate of candidates) {
      const path = resolve(candidate);
      const fileName = path.split(/[/\\]/u).pop() ?? path;
      assertSafeIdentifier(fileName, `Instruction file name`);
      if (!(await this.#exists(path))) continue;
      const content = await this.#readInstructionFile(path, scope);
      discovered.push({
        scope,
        name: fileName,
        priority: priority++,
        path,
        content,
      });
      break;
    }

    discovered.sort((left, right) => left.priority - right.priority);
    return discovered;
  }

  async #readInstructionFile(path: string, scope: InstructionScope): Promise<string> {
    const content = await readFile(path, "utf8");
    const maxBytes = this.#options.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES;
    const size = Buffer.byteLength(content, "utf8");
    if (size > maxBytes) {
      throw new Error(`Instruction file exceeds size limit (${scope}): ${path}`);
    }
    if (content.includes("\0")) {
      throw new Error(`Instruction file cannot contain null bytes: ${path}`);
    }
    const root = dirname(path);
    await assertPathInsideRoot(root, path, "Instruction file");
    return content;
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  #appendSource(sources: InstructionSource[], source: InstructionSource, totalBytes: number): number {
    const maxTotal = this.#options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    totalBytes = this.#addBytes(totalBytes, Buffer.byteLength(source.content, "utf8"));
    if (totalBytes > maxTotal) {
      throw new Error(`Instruction set exceeds total size limit after loading ${source.path}`);
    }
    sources.push(source);
    return totalBytes;
  }

  #addBytes(current: number, delta: number): number {
    const next = current + delta;
    const maxTotal = this.#options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    if (next > maxTotal) {
      throw new Error(`Instruction set exceeds total size limit (${maxTotal} bytes)`);
    }
    return next;
  }

  #priorityForScope(scope: InstructionScope): number {
    switch (scope) {
      case "managed": return 0;
      case "user": return 100;
      case "project": return 200;
      case "local": return 300;
      case "session": return 400;
    }
  }
}

export async function createDefaultInstructionPrompt(options: InstructionLoaderOptions): Promise<string> {
  const loader = new InstructionLoader(options);
  const instructions = await loader.load();
  if (options.eventSink && options.runId) {
    await options.eventSink.emit(createRuntimeEvent("instruction.load.end", {
      count: instructions.length,
    }, {
      runId: options.runId,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      sequence: 1,
      source: "core",
    }));
  }
  return instructions.map((instruction) => instruction.content).join("\n\n---\n\n");
}

export function resolveInstructionPath(configDirectory: string, input: string): string {
  return resolveSafeRelativePath(configDirectory, input);
}
