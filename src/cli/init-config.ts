import type { AgentConfigInput } from "../config/config-schema.js";
import { MINGXU_IDENTITY_PROMPT } from "./identity.js";

export type InitProfile = "minimal" | "secure-local";

/**
 * Builds stable starter configs for new users.
 *
 * The goal is not to guess their whole setup, but to generate one valid config
 * that matches the current schema and is easy to inspect and edit.
 */
export function createInitConfig(profile: InitProfile): AgentConfigInput {
  const base: AgentConfigInput = {
    name: "mingxu",
    systemPrompt: MINGXU_IDENTITY_PROMPT,
    defaultModel: "primary",
    models: {
      primary: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        apiKey: "env:ANTHROPIC_API_KEY",
      },
    },
    maxIterations: 10,
    plugins: [],
  };

  if (profile === "minimal") {
    return base;
  }

  return {
    ...base,
    runtime: {
      limits: {
        maxIterations: 10,
        maxModelRequests: 10,
        maxToolCalls: 10,
        maxDurationMs: 60_000,
        maxConcurrentTools: 1,
      },
    },
    session: {
      enabled: true,
      dir: ".mingxu/sessions",
      save: true,
      retentionDays: 7,
    },
    audit: {
      enabled: true,
      file: ".mingxu/audit/runtime.jsonl",
      failClosedForHighRisk: true,
    },
    secrets: {
      allowEnv: true,
    },
  };
}

export function renderInitConfig(profile: InitProfile): string {
  return `${JSON.stringify(createInitConfig(profile), null, 2)}\n`;
}
