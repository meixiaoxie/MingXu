import type { AgentSession } from "../core/agent-session.js";
import type { SessionSummary } from "../session/types.js";
import type { AgentPresetV1 } from "../presets/agent-preset-registry.js";
import type { ResolvedResource } from "../resources/resource-types.js";
import type { SkillDescriptor } from "../skills/skill-registry.js";
import type { SubagentCancelRequest, SubagentCancelResult, SubagentSnapshot } from "../subagents/subagent-manager.js";
import type { ConfigLayerInfo } from "./config-discovery.js";
import type { ApprovalHandler } from "../approval/types.js";
import type { ExtensionDescriptor } from "../extensions/protocol.js";

export interface CliSessionRequest {
  readonly modelKey?: string;
  readonly sessionId?: string;
  readonly preset?: AgentPresetV1;
  readonly approvalHandler?: ApprovalHandler;
  readonly principalId?: string;
  readonly interactive?: boolean;
}

export interface CliRuntimeSnapshot {
  readonly configFilePath: string;
  readonly projectTrusted: boolean;
  readonly configSources: readonly ConfigLayerInfo[];
  readonly defaultModel: string;
  readonly models: readonly {
    readonly key: string;
    readonly provider: string;
    readonly model: string;
  }[];
  readonly sessions: readonly SessionSummary[];
  readonly resources: readonly ResolvedResource[];
  readonly skills: readonly SkillDescriptor[];
  readonly presets: readonly AgentPresetV1[];
  readonly extensions: readonly ExtensionDescriptor[];
  readonly mcpServers: readonly {
    readonly name: string;
    readonly transport: string;
    readonly connected: boolean;
  }[];
  readonly subagents: SubagentSnapshot;
  readonly audit: {
    readonly enabled: boolean;
    readonly file?: string | undefined;
    readonly healthy: boolean;
    readonly failClosedForHighRisk: boolean;
  };
  readonly instructions: {
    readonly systemPrompt?: string | undefined;
    readonly autoLoadClaudeMd?: boolean | undefined;
    readonly managed?: string[] | undefined;
    readonly user?: string[] | undefined;
    readonly project?: string[] | undefined;
    readonly local?: string[] | undefined;
    readonly session?: string[] | undefined;
  };
}

export interface CliRuntimeContext {
  createSession(request?: CliSessionRequest): AgentSession;
  listSessions(): Promise<string>;
  listRecentSessions(limit?: number): Promise<readonly SessionSummary[]>;
  snapshot(): Promise<CliRuntimeSnapshot>;
  cancelSubagents?(request: SubagentCancelRequest): Promise<SubagentCancelResult> | SubagentCancelResult;
  close(): Promise<void>;
}
