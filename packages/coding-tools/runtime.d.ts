import type {
  PluginContribution,
  PluginContextV1,
  PluginManifestV1,
  PluginModuleV1,
  ToolGovernance,
} from "@mingxu/plugin-sdk";

export const CODING_TOOL_NAMES: readonly ["read", "list", "search", "write", "edit", "command"];

export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];

export type CodingToolGovernance = ToolGovernance;

export interface CodingToolContribution extends PluginContribution {
  readonly kind: "tool";
  readonly name: CodingToolName;
}

export interface CodingToolEntry {
  readonly name: CodingToolName;
  readonly description: string;
  readonly governance: CodingToolGovernance;
}

export interface CodingToolsManifestV1 extends PluginManifestV1 {
  readonly adapterId: "mingxu-native";
  readonly entry: string;
  readonly description: string;
  readonly permissions: {
    readonly files: "read" | "write";
    readonly commands: "allow";
    readonly network: "none";
  };
  readonly contributions: readonly CodingToolContribution[];
}

export interface CodingToolsPluginOptions {
  readonly workspaceRoot?: string;
}

export interface CodingToolsPlugin extends PluginModuleV1 {
  readonly manifest: CodingToolsManifestV1;
  healthCheck?(): boolean | Promise<boolean>;
}

export declare const codingToolEntries: Record<CodingToolName, CodingToolEntry>;
export declare const codingToolsManifest: CodingToolsManifestV1;
export declare function createCodingToolsPlugin(options?: CodingToolsPluginOptions): CodingToolsPlugin;
export declare const codingToolsPlugin: CodingToolsPlugin;

export default codingToolsPlugin;
