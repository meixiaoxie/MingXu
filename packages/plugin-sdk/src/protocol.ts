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
  readonly adapterId?: string;
}

export interface PluginToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly governance?: ToolGovernance;
  execute?(input: unknown, context?: PluginToolExecutionContext): unknown | Promise<unknown>;
  prepare?(input: unknown, context?: PluginToolExecutionContext): PreparedToolMutation | Promise<PreparedToolMutation>;
  commit?(preparation: PreparedToolMutation, context?: PluginToolExecutionContext): unknown | Promise<unknown>;
}

export interface PluginToolExecutionContext {
  readonly signal?: AbortSignal;
}

export interface ToolMutationBinding {
  readonly protocolVersion: "mingxu/tool-mutation-v1";
  readonly operation: string;
  readonly workspaceRoot: string;
  readonly requestedPath: string;
  readonly normalizedPath: string;
  readonly baselineHash: string;
  readonly baselineExists: boolean;
  readonly baselineMode: number | null;
  readonly targetHash: string;
  readonly changeFingerprint: string;
}

export interface ToolMutationSummary {
  readonly operation: string;
  readonly path: string;
  readonly diffRef: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface PreparedToolMutation {
  readonly protocol: "mingxu/tool-mutation-v1";
  readonly binding: ToolMutationBinding;
  readonly summary: ToolMutationSummary;
  readonly presentation: PresentationBlock & { readonly kind: "diff" };
  readonly opaque: unknown;
}

export interface PluginEvent {
  readonly type: string;
  readonly source?: string;
  readonly payload?: unknown;
}

export interface PluginEventSink {
  emit(event: unknown): void | Promise<void>;
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
  readonly adapterId: string;
  readonly manifest: PluginManifestV1;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly entryPath: string;
  readonly manifestHash: string;
  readonly sha256: string;
  readonly source: ExtensionSource;
  readonly upstreamId?: string;
  readonly upstreamVersion?: string;
  readonly upstreamManifestHash?: string;
  readonly capabilities?: readonly string[];
  readonly unsupportedCapabilities?: readonly string[];
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
  readonly upstreamId?: string;
  readonly upstreamVersion?: string;
  readonly upstreamManifestHash?: string;
  readonly capabilities?: readonly string[];
  readonly unsupportedCapabilities?: readonly string[];
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
  probe(packageRoot: string): Promise<number | false>;
  inspect(packageRoot: string, source: ExtensionSource): Promise<ExtensionInspectResult>;
  load(packageRoot: string, source: ExtensionSource): Promise<PluginModuleV1>;
}

export type ExtensionKind = PluginKind;
export type ExtensionContribution = PluginContribution;
export type ExtensionManifestV1 = PluginManifestV1;
export type ExtensionPermissions = PluginPermissions;
export type ExtensionPluginContext = PluginContextV1;
export type ExtensionPlugin = PluginModuleV1;

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
  if (manifest.permissions !== undefined) {
    if (manifest.permissions.files !== undefined && !["none", "read", "write"].includes(manifest.permissions.files)) {
      throw new Error("Plugin manifest permissions.files is invalid");
    }
    if (manifest.permissions.network !== undefined && !["none", "allow"].includes(manifest.permissions.network)) {
      throw new Error("Plugin manifest permissions.network is invalid");
    }
    if (manifest.permissions.commands !== undefined && !["none", "allow"].includes(manifest.permissions.commands)) {
      throw new Error("Plugin manifest permissions.commands is invalid");
    }
  }
  return manifest;
}

export function defineExtensionAdapter(adapter: ExtensionAdapterV1): ExtensionAdapterV1 {
  if (!adapter.adapterId.trim()) {
    throw new Error("Extension adapter id is required");
  }
  return adapter;
}
