import { z } from "zod";

import { defineTool } from "../tool.js";

const echoInputSchema = z.object({
  message: z.string(),
});

/** Returns the supplied text unchanged, making it useful for smoke tests and examples. */
export const echoTool = defineTool({
  name: "echo",
  description: "Return the provided message unchanged.",
  inputSchema: echoInputSchema,
  execute: ({ message }) => message,
});
