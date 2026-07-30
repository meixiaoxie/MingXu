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
      // Skeleton only; real execution comes from a future adapter package.
    },
  };
}

export const codingToolsPluginSkeleton = createCodingToolsPluginSkeleton();
