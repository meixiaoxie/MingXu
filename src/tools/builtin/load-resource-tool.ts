import { z } from "zod";

import { defineTool, type RuntimeTool } from "../tool.js";
import type { ResourceKind } from "../../resources/resource-types.js";
import type { ResourceLoader } from "../../resources/resource-loader.js";

const loadResourceInputSchema = z.object({
  kind: z.enum(["skill", "rule", "prompt", "mcp_resource", "mcp_prompt"]),
  name: z.string().trim().min(1),
}).strict();

type LoadResourceInput = z.infer<typeof loadResourceInputSchema>;

export interface LoadResourceToolOptions {
  readonly resourceLoader: ResourceLoader;
}

export function createLoadResourceTool(
  options: LoadResourceToolOptions,
): RuntimeTool<LoadResourceInput, { kind: ResourceKind; name: string; content: string; bytes: number }> {
  return defineTool({
    name: "load_resource",
    description: "Load a registered resource body by kind and name.",
    inputSchema: loadResourceInputSchema,
    riskLevel: "low",
    async execute(input, context) {
      context?.signal?.throwIfAborted();
      const resource = await options.resourceLoader.load(input.kind, input.name);
      return {
        kind: input.kind,
        name: input.name,
        content: resource.text,
        bytes: resource.bytes,
      };
    },
  });
}
