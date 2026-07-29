import { assertSafeIdentifier } from "../safety/path-safety.js";
import type { ResolvedResource, ResourceDescriptor, ResourceKind } from "./resource-types.js";

export class ResourceRegistry {
  readonly #resources = new Map<string, ResolvedResource>();

  register(resource: ResourceDescriptor): this {
    assertSafeIdentifier(resource.name, "Resource name");
    const key = resourceKey(resource.kind, resource.name);
    if (this.#resources.has(key)) {
      throw new Error(`Resource already registered: ${resource.kind}:${resource.name}`);
    }
    this.#resources.set(key, { ...resource });
    return this;
  }

  has(kind: ResourceKind, name: string): boolean {
    return this.#resources.has(resourceKey(kind, name));
  }

  get(kind: ResourceKind, name: string): ResolvedResource | undefined {
    return this.#resources.get(resourceKey(kind, name));
  }

  list(): ReadonlyArray<ResolvedResource> {
    return [...this.#resources.values()];
  }

  listVisible(visibility: ResourceDescriptor["visibility"]): ReadonlyArray<ResolvedResource> {
    return this.list().filter((resource) => resource.visibility === visibility);
  }
}

function resourceKey(kind: ResourceKind, name: string): string {
  return `${kind}:${name}`;
}
