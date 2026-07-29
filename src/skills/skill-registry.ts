import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import type { ResourceDescriptor, ResourceKind, ResourceVisibility } from "../resources/resource-types.js";
import { assertSafeIdentifier, assertSafeLocalPath } from "../safety/path-safety.js";

export const skillManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  entry: z.string().min(1).optional(),
  resources: z.array(z.string().min(1)).optional(),
  visibility: z.enum(["managed", "user", "project", "local", "session"]).optional(),
}).strict();

export type SkillManifestV1 = z.infer<typeof skillManifestSchema>;

export interface SkillDescriptor {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly rootPath: string;
  readonly manifestPath: string;
  readonly entryPath: string;
  readonly visibility: ResourceVisibility;
  readonly resources: readonly ResourceDescriptor[];
}

export class SkillRegistry {
  readonly #skills = new Map<string, SkillDescriptor>();

  register(skill: SkillDescriptor): this {
    assertSafeIdentifier(skill.name, "Skill name");
    if (this.#skills.has(skill.name)) {
      throw new Error(`Skill already registered: ${skill.name}`);
    }
    this.#skills.set(skill.name, skill);
    return this;
  }

  get(name: string): SkillDescriptor | undefined {
    return this.#skills.get(name);
  }

  list(): SkillDescriptor[] {
    return [...this.#skills.values()];
  }

  async loadDirectory(rootPath: string): Promise<SkillDescriptor[]> {
    const manifestPath = resolve(rootPath, "skill.json");
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = skillManifestSchema.parse(JSON.parse(manifestRaw));
    const entryPath = resolve(rootPath, manifest.entry ?? "SKILL.md");
    const visibility = manifest.visibility ?? "project";
    const resources = (manifest.resources ?? []).map((entry) => ({
      kind: "skill" as ResourceKind,
      name: `${manifest.name}:${entry}`,
      visibility,
      path: resolve(rootPath, entry),
      source: "local_file" as const,
    }));

    for (const resource of resources) {
      assertSafeLocalPath(resource.path ?? "", "Skill resource path");
    }

    const skill: SkillDescriptor = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      rootPath: resolve(rootPath),
      manifestPath,
      entryPath,
      visibility,
      resources,
    };
    this.register(skill);
    return [skill];
  }

  loadEntry(skillName: string): Promise<string> {
    const skill = this.get(skillName);
    if (!skill) {
      throw new Error(`Unknown skill: ${skillName}`);
    }
    return readFile(skill.entryPath, "utf8");
  }
}
