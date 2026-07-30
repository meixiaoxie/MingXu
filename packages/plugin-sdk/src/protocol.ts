export const PLUGIN_API_VERSION = "mingxu/plugin-v1" as const;

export type PluginApiVersion = typeof PLUGIN_API_VERSION;

export type PluginKind =
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

export interface ToolGovernance {
  readonly kind: "generic" | "file" | "command" | "network";
  readonly action?: "read" | "write" | "exec" | "request";
  readonly rootDirectory?: string;
  readonly pathField?: string;
  readonly argvField?: string;
  readonly cwdField?: string;
  readonly envFields?: readonly string[];
  readonly timeoutMsField?: string;
  readonly maxOutputBytesField?: string;
  readonly urlField?: string;
}

export interface PluginPermissions {
  readonly files?: "none" | "read" | "write";
  readonly network?: "none" | "allow";
  readonly commands?: "none" | "allow";
  readonly env?: readonly string[];
}

export interface PluginContribution {
  readonly kind: PluginKind;
  readonly name: string;
  readonly description?: string;
}

export interface PluginManifestV1 {
  readonly apiVersion: PluginApiVersion;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: PluginKind;
  readonly entry?: string;
  readonly description?: string;
  readonly configSchema?: unknown;
  readonly permissions?: PluginPermissions;
  readonly contributions: readonly PluginContribution[];
}

export interface PluginToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly governance?: ToolGovernance;
}

export interface PluginEvent {
  readonly type: string;
  readonly source?: string;
  readonly payload?: unknown;
}

export interface PluginEventSink {
  emit(event: PluginEvent): void;
}

export interface PluginContextV1 {
  registerTool(tool: PluginToolDefinition): void;
  unregisterTool?(name: string): boolean;
  eventSink?: PluginEventSink;
}

export interface PluginModuleV1 {
  readonly name: string;
  readonly manifest: PluginManifestV1;
  readonly kind?: PluginKind;
  readonly riskLevel?: "low" | "high";
  readonly policyRootDirectory?: string;
  setup(context: PluginContextV1): void | Promise<void>;
  activate?(context: PluginContextV1): void | Promise<void>;
  deactivate?(context: PluginContextV1): void | Promise<void>;
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

export interface ExtensionInspectResult {
  readonly manifest: PluginManifestV1;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly entryPath: string;
  readonly manifestHash: string;
  readonly sha256: string;
  readonly source: ExtensionSource;
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
  readonly permissions?: PluginPermissions;
  readonly contributions: readonly PluginContribution[];
  readonly health: "healthy" | "unhealthy" | "unknown";
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly error?: string;
}

export interface ExtensionLockRecord extends ExtensionDescriptor {}

export interface ExtensionLockFile {
  readonly schemaVersion: "extensions/v1";
  readonly updatedAt: string;
  readonly records: readonly ExtensionLockRecord[];
}

export interface ExtensionAdapterV1 {
  readonly adapterId: string;
  supports(source: ExtensionSource, manifest: PluginManifestV1): boolean;
  inspect(source: ExtensionSource): Promise<ExtensionInspectResult>;
}

export function definePluginManifest(manifest: PluginManifestV1): PluginManifestV1 {
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error("Plugin manifest apiVersion must be mingxu/plugin-v1");
  }
  if (!manifest.id.trim()) {
    throw new Error("Plugin manifest id is required");
  }
  if (!manifest.name.trim()) {
    throw new Error("Plugin manifest name is required");
  }
  if (!manifest.version.trim()) {
    throw new Error("Plugin manifest version is required");
  }
  if (!manifest.kind.trim()) {
    throw new Error("Plugin manifest kind is required");
  }
  if (!Array.isArray(manifest.contributions)) {
    throw new Error("Plugin manifest contributions must be an array");
  }
  return manifest;
}

export function defineExtensionAdapter(adapter: ExtensionAdapterV1): ExtensionAdapterV1 {
  if (!adapter.adapterId.trim()) {
    throw new Error("Extension adapter id is required");
  }
  return adapter;
}
