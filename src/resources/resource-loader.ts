import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { EventSink } from "../events/event-sink.js";
import { createRuntimeEvent } from "../events/runtime-events.js";
import { assertPathInsideRoot, assertSafeIdentifier } from "../safety/path-safety.js";
import type { ResolvedResource, ResourceContent, ResourceDescriptor } from "./resource-types.js";
import type { ResourceRegistry } from "./resource-registry.js";

export interface ResourceLoaderOptions {
  readonly registry: ResourceRegistry;
  readonly eventSink?: EventSink;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly maxResourceBytes?: number;
  readonly maxRunBytes?: number;
}

const DEFAULT_MAX_RESOURCE_BYTES = 256 * 1024;
const DEFAULT_MAX_RUN_BYTES = 1024 * 1024;

export class ResourceLoader {
  readonly #options: ResourceLoaderOptions;
  #loadedBytes = 0;

  constructor(options: ResourceLoaderOptions) {
    this.#options = options;
  }

  list(): ReadonlyArray<ResolvedResource> {
    return this.#options.registry.list();
  }

  async load(kind: ResourceDescriptor["kind"], name: string): Promise<ResourceContent> {
    assertSafeIdentifier(name, "Resource name");
    const resource = this.#options.registry.get(kind, name);
    if (!resource) {
      throw new Error(`Unknown resource: ${kind}:${name}`);
    }
    await this.#emit("resource.load.start", { kind, name });
    const content = await this.#loadResourceContent(resource);
    await this.#emit("resource.load.end", { kind, name, bytes: content.bytes });
    return content;
  }

  async loadResource(resource: ResourceDescriptor): Promise<ResourceContent> {
    const registered = this.#options.registry.get(resource.kind, resource.name) ?? resource;
    return this.#loadResourceContent(registered);
  }

  async discover(): Promise<ReadonlyArray<ResolvedResource>> {
    await this.#emit("resource.discover", { count: this.list().length });
    return this.list();
  }

  async #loadResourceContent(resource: ResourceDescriptor): Promise<ResourceContent> {
    if (resource.loader) {
      const loaded = await resource.loader();
      return typeof loaded === "string" ? this.#boundContent(resource, loaded) : this.#boundContent(resource, loaded.text);
    }
    if (resource.source === "inline" && typeof resource.metadata?.text === "string") {
      const text = resource.metadata.text;
      return this.#boundContent(resource, text);
    }

    if (!resource.path) {
      throw new Error(`Resource has no readable body: ${resource.kind}:${resource.name}`);
    }

    const resolvedPath = resolve(resource.path);
    if (resource.source === "local_file") {
      await assertPathInsideRoot(dirname(resolvedPath), resolvedPath, "Resource file");
    }
    const text = await readFile(resolvedPath, "utf8");
    return this.#boundContent(resource, text);
  }

  #boundContent(resource: ResourceDescriptor, text: string): ResourceContent {
    const maxResourceBytes = resource.maxBytes ?? this.#options.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxResourceBytes) {
      throw new Error(`Resource exceeds per-item size limit: ${resource.kind}:${resource.name}`);
    }
    const nextTotal = this.#loadedBytes + bytes;
    const maxRunBytes = this.#options.maxRunBytes ?? DEFAULT_MAX_RUN_BYTES;
    if (nextTotal > maxRunBytes) {
      throw new Error(`Resource load exceeds run size limit: ${resource.kind}:${resource.name}`);
    }
    this.#loadedBytes = nextTotal;
    return { text, bytes };
  }

  async #emit(eventType: "resource.discover" | "resource.load.start" | "resource.load.end", payload: Record<string, unknown>): Promise<void> {
    if (!this.#options.eventSink || !this.#options.runId) return;
    await this.#options.eventSink.emit(createRuntimeEvent(eventType, payload, {
      runId: this.#options.runId,
      ...(this.#options.sessionId !== undefined ? { sessionId: this.#options.sessionId } : {}),
      sequence: 1,
      source: "core",
    }));
  }
}
