import type { Tool } from "../core/types.js";
import type { EventSink } from "../events/event-sink.js";

export type ExtensionKind =
  | "tool"
  | "provider"
  | "memory"
  | "policy"
  | "audit"
  | "context"
  | "preset"
  | "skill"
  | "resource";

export type PresentationBlockKind = "markdown" | "diff" | "command" | "table" | "tree" | "keyvalue" | "progress";

export type PresentationBlockState = "streaming" | "complete" | "error" | "collapsed";

export interface PresentationBlock {
  readonly id: string;
  readonly kind: PresentationBlockKind;
  readonly revision?: number;
  readonly source?: string;
  readonly sensitivity?: "public" | "internal" | "secret";
  readonly state?: PresentationBlockState;
  readonly payload?: unknown;
}

export interface ExtensionPermissions {
  readonly files?: "none" | "read" | "write";
  readonly network?: "none" | "allow";
  readonly commands?: "none" | "allow";
  readonly env?: readonly string[];
}

export interface ExtensionContribution {
  readonly kind: ExtensionKind;
  readonly name: string;
  readonly description?: string;
}

export interface ExtensionManifestV1 {
  readonly apiVersion: "mingxu/plugin-v1";
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: ExtensionKind;
  readonly entry?: string;
  readonly description?: string;
  readonly configSchema?: unknown;
  readonly permissions?: ExtensionPermissions;
  readonly contributions: readonly ExtensionContribution[];
}

export interface ExtensionPluginContext {
  registerTool(tool: Tool): void;
  unregisterTool?(name: string): boolean;
  eventSink?: EventSink;
}

export interface ExtensionPlugin {
  readonly name: string;
  readonly manifest?: ExtensionManifestV1;
  kind?: ExtensionKind;
  riskLevel?: "low" | "high";
  policyRootDirectory?: string;
  setup(context: ExtensionPluginContext): void | Promise<void>;
  activate?(context: ExtensionPluginContext): void | Promise<void>;
  deactivate?(context: ExtensionPluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
  healthCheck?(): boolean | Promise<boolean>;
}

export type ExtensionSourceKind = "directory" | "tarball" | "npm" | "git";

export interface ExtensionSource {
  readonly kind: ExtensionSourceKind;
  readonly locator: string;
  readonly path?: string;
  readonly integrity?: string;
  readonly commit?: string;
}

export interface ExtensionDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly adapterId: string;
  readonly scope: "user" | "project";
  readonly enabled: boolean;
  readonly source: ExtensionSource;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly entryPath: string;
  readonly manifestHash: string;
  readonly sha256: string;
  readonly permissions?: ExtensionPermissions;
  readonly contributions: readonly ExtensionContribution[];
  readonly health: "healthy" | "unhealthy" | "unknown";
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly error?: string;
}

export interface ExtensionLockRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly adapterId: string;
  readonly scope: "user" | "project";
  readonly enabled: boolean;
  readonly source: ExtensionSource;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly entryPath: string;
  readonly manifestHash: string;
  readonly sha256: string;
  readonly permissions?: ExtensionPermissions;
  readonly contributions: readonly ExtensionContribution[];
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly error?: string;
}

export interface ExtensionLockFile {
  readonly schemaVersion: "extensions/v1";
  readonly updatedAt: string;
  readonly records: readonly ExtensionLockRecord[];
}

export interface ExtensionInspectResult {
  readonly manifest: ExtensionManifestV1;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly entryPath: string;
  readonly manifestHash: string;
  readonly sha256: string;
  readonly source: ExtensionSource;
}

export interface ExtensionAdapterV1 {
  readonly adapterId: string;
  supports(source: ExtensionSource, manifest: ExtensionManifestV1): boolean;
  inspect(source: ExtensionSource): Promise<ExtensionInspectResult>;
}
