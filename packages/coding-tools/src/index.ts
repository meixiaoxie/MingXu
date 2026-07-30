import { codingToolsManifest } from "./manifest.js";

export {
  CODING_TOOL_NAMES,
  codingToolEntries,
  codingToolsManifest,
} from "./manifest.js";
export type {
  CodingToolContribution,
  CodingToolEntry,
  CodingToolGovernance,
  CodingToolName,
  CodingToolsManifestV1,
} from "./manifest.js";

export interface CodingToolsPluginSkeleton {
  readonly name: string;
  readonly manifest: import("./manifest.js").CodingToolsManifestV1;
  setup(): void;
}

export function createCodingToolsPluginSkeleton(): CodingToolsPluginSkeleton {
  return {
    name: codingToolsManifest.name,
    manifest: codingToolsManifest,
    setup() {
      // 这里先保留为空：真正的工具执行器会在后续接入。
    },
  };
}

export const codingToolsPluginSkeleton = createCodingToolsPluginSkeleton();
