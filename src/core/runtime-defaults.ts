// Shared by config parsing and the direct agent-loop API so both entry points
// use the same safety limit instead of silently drifting apart.
export const DEFAULT_MAX_ITERATIONS = 10;
