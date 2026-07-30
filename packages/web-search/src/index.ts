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
      // Skeleton only; real execution comes from a future adapter package.
    },
  } satisfies WebSearchPluginSkeleton;
}

export const webSearchPluginSkeleton = createWebSearchPluginSkeleton();
