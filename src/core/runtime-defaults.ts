// Shared by config parsing and the direct agent-loop API so both entry points
// use the same safety limit instead of silently drifting apart.
export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_MAX_MODEL_REQUESTS = 20;
export const DEFAULT_MAX_TOOL_CALLS = 20;
export const DEFAULT_MAX_CONCURRENT_TOOLS = 1;
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 256;
export const DEFAULT_TOOL_MAX_OUTPUT_BYTES = 16 * 1024;
