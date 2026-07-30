import type {
  ExtensionAdapterV1,
  ExtensionDescriptor,
  ExtensionInspectResult,
  ExtensionLockFile,
  ExtensionLockRecord,
  ExtensionManifestV1,
  ExtensionPermissions,
  ExtensionSource,
  ExtensionSourceKind,
  PluginApiVersion,
  PluginContribution,
  PluginContextV1,
  PluginEvent,
  PluginEventSink,
  PluginKind,
  PluginManifestV1,
  PluginModuleV1,
  PluginPermissions,
  PluginToolDefinition,
  PresentationBlock,
  PresentationBlockKind,
  PresentationBlockState,
  ToolGovernance,
} from "@mingxu/plugin-sdk";

export const PLUGIN_API_VERSION = "mingxu/plugin-v1" as const;

export type {
  ExtensionAdapterV1,
  ExtensionDescriptor,
  ExtensionInspectResult,
  ExtensionLockFile,
  ExtensionLockRecord,
  ExtensionManifestV1,
  ExtensionPermissions,
  ExtensionSource,
  ExtensionSourceKind,
  PluginApiVersion,
  PluginContribution,
  PluginContextV1,
  PluginEvent,
  PluginEventSink,
  PluginKind,
  PluginManifestV1,
  PluginModuleV1,
  PluginPermissions,
  PluginToolDefinition,
  PresentationBlock,
  PresentationBlockKind,
  PresentationBlockState,
  ToolGovernance,
};

export type Plugin = PluginModuleV1;
export type PluginContext = PluginContextV1;
export type ExtensionKind = PluginKind;
export type ExtensionPluginContext = PluginContextV1;
export type ExtensionPlugin = PluginModuleV1;
export type ExtensionContribution = PluginContribution;

export function definePluginManifest(manifest: PluginManifestV1): PluginManifestV1 {
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error("Plugin manifest apiVersion must be mingxu/plugin-v1");
  }
  if (typeof manifest.id !== "string" || !manifest.id.trim()) {
    throw new Error("Plugin manifest id is required");
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new Error("Plugin manifest name is required");
  }
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("Plugin manifest version is required");
  }
  if (typeof manifest.kind !== "string" || !manifest.kind.trim()) {
    throw new Error("Plugin manifest kind is required");
  }
  if (!Array.isArray(manifest.contributions)) {
    throw new Error("Plugin manifest contributions must be an array");
  }
  if (manifest.permissions !== undefined) {
    validatePermissions(manifest.permissions);
  }
  return manifest;
}

export function defineExtensionAdapter(adapter: ExtensionAdapterV1): ExtensionAdapterV1 {
  if (typeof adapter.adapterId !== "string" || !adapter.adapterId.trim()) {
    throw new Error("Extension adapter id is required");
  }
  return adapter;
}

export function definePlugin(plugin: PluginModuleV1): PluginModuleV1 {
  if (typeof plugin.name !== "string" || !plugin.name.trim()) {
    throw new Error("Plugin name is required");
  }
  if (typeof plugin.setup !== "function") {
    throw new Error("Plugin setup function is required");
  }
  if (plugin.manifest !== undefined) {
    definePluginManifest(plugin.manifest);
  }
  return plugin;
}

function validatePermissions(permissions: PluginPermissions): void {
  if (permissions.files !== undefined && !["none", "read", "write"].includes(permissions.files)) {
    throw new Error("Plugin manifest permissions.files is invalid");
  }
  if (permissions.network !== undefined && !["none", "allow"].includes(permissions.network)) {
    throw new Error("Plugin manifest permissions.network is invalid");
  }
  if (permissions.commands !== undefined && !["none", "allow"].includes(permissions.commands)) {
    throw new Error("Plugin manifest permissions.commands is invalid");
  }
}
