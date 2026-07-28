import {
  type AgentConfigInput,
  type ResolvedAgentConfig,
  resolveAgentConfig,
} from "./config-schema.js";

/** Validates inline configuration and returns the canonical runtime shape. */
export function defineAgentConfig(config: AgentConfigInput): ResolvedAgentConfig {
  return resolveAgentConfig(config);
}
