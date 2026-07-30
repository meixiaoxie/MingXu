import { defaultWebSearchConfig, webSearchManifest } from "./manifest.js";
import type { WebSearchPluginSkeleton } from "./manifest.js";

export {
  WEB_SEARCH_BACKENDS,
  defaultWebSearchConfig,
  webSearchManifest,
} from "./manifest.js";
export type {
  WebSearchBackend,
  WebSearchConfig,
  WebSearchContribution,
  WebSearchManifestV1,
  WebSearchPluginSkeleton,
} from "./manifest.js";

export function createWebSearchPluginSkeleton(config = defaultWebSearchConfig) {
  return {
    name: webSearchManifest.name,
    manifest: webSearchManifest,
    config,
    setup() {
      // 这个骨架只声明能力边界，真正的联网后端后续再接入。
    },
  } satisfies WebSearchPluginSkeleton;
}

export const webSearchPluginSkeleton = createWebSearchPluginSkeleton();
