export type ResourceKind = "skill" | "rule" | "prompt" | "mcp_resource" | "mcp_prompt";
export type ResourceVisibility = "managed" | "user" | "project" | "local" | "session";

export interface ResourceContent {
  readonly text: string;
  readonly bytes: number;
}

export interface ResourceDescriptor {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly visibility: ResourceVisibility;
  readonly description?: string;
  readonly version?: string;
  readonly path?: string;
  readonly source?: "local_file" | "inline" | "mcp";
  readonly loader?: () => Promise<ResourceContent | string>;
  readonly metadata?: Record<string, unknown>;
  readonly maxBytes?: number;
}

export interface ResolvedResource extends ResourceDescriptor {
  readonly bytes?: number;
}
