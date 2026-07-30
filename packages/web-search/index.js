const manifest = {
  apiVersion: "mingxu/plugin-v1",
  id: "mingxu-web-search",
  name: "MingXu Web Search",
  version: "0.4.0",
  kind: "tool",
  adapterId: "mingxu-native",
  entry: "index.js",
  description: "Optional web search plugin skeleton for future Brave, Tavily, and SearXNG adapters.",
  permissions: {
    files: "none",
    network: "allow",
    commands: "none",
  },
  contributions: [
    { kind: "tool", name: "web_search", description: "Search the web through a configured backend and return structured sources." },
  ],
};

export default {
  name: manifest.name,
  manifest,
  async setup(context) {
    context.registerTool({
      name: "web_search",
      description: "Search the web through a configured backend and return structured sources.",
      inputSchema: { type: "object" },
      kind: "network",
      riskLevel: "high",
      policyRootDirectory: "workspace",
      governance: {
        kind: "network",
        action: "request",
        urlField: "url",
      },
      async execute() {
        throw new Error("web-search skeleton: web_search is not implemented yet");
      },
    });
  },
};
