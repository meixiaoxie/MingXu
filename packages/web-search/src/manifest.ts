export const WEB_SEARCH_BACKENDS = ["auto", "brave", "tavily", "searxng"] as const;

export type WebSearchBackend = (typeof WEB_SEARCH_BACKENDS)[number];

export interface WebSearchConfig {
  readonly backend?: WebSearchBackend;
  readonly resultLimit?: number;
  readonly timeRange?: "day" | "week" | "month" | "year";
  readonly domains?: readonly string[];
}

export interface WebSearchContribution {
  readonly kind: "tool";
  readonly name: "web_search";
  readonly description: string;
}

export interface WebSearchManifestV1 {
  readonly apiVersion: "mingxu/plugin-v1";
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: "tool";
  readonly entry: string;
  readonly description: string;
  readonly permissions: {
    readonly files: "none";
    readonly network: "allow";
    readonly commands: "none";
  };
  readonly contributions: readonly WebSearchContribution[];
}

export interface WebSearchPluginSkeleton {
  readonly name: string;
  readonly manifest: WebSearchManifestV1;
  readonly config: WebSearchConfig;
  setup(): void;
}

export const webSearchManifest: WebSearchManifestV1 = {
  apiVersion: "mingxu/plugin-v1",
  id: "mingxu-web-search",
  name: "MingXu Web Search",
  version: "0.4.0",
  kind: "tool",
  entry: "dist/index.js",
  description: "Optional web search plugin skeleton for future Brave, Tavily, and SearXNG adapters.",
  permissions: {
    files: "none",
    network: "allow",
    commands: "none",
  },
  contributions: [
    {
      kind: "tool",
      name: "web_search",
      description: "Search the web through a configured backend and return structured sources.",
    },
  ],
};

export const defaultWebSearchConfig: WebSearchConfig = {
  backend: "auto",
  resultLimit: 5,
  timeRange: "week",
};
