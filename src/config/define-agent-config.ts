import {
  agentConfigSchema,
  type AgentConfig,
  type AgentConfigInput,
} from "./config-schema.js";

/** Validates inline configuration immediately, close to where it is authored. */
export function defineAgentConfig(config: AgentConfigInput): AgentConfig {
  return agentConfigSchema.parse(config);
}
