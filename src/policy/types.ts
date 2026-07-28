export type PolicyEffect = "allow" | "deny" | "ask";

export type PolicyActionKind =
  | "tool.call"
  | "file.read"
  | "file.write"
  | "network.request"
  | "command.exec";

export interface PolicyPrincipal {
  kind: "user" | "agent" | "plugin" | "system";
  id: string;
  sessionId?: string;
  pluginName?: string;
}

export interface PolicyAction {
  kind: PolicyActionKind;
  name: string;
  mode?: "read" | "write" | "exec" | "connect";
}

export interface FilePolicyResource {
  kind: "file";
  root: string;
  requestedPath: string;
  resolvedPath: string;
  realPath?: string;
  caseNormalizedPath: string;
  isUnc: boolean;
}

export interface NetworkPolicyResource {
  kind: "network";
  url: string;
  scheme: string;
  host: string;
  port: number;
  isPrivateAddress: boolean;
}

export interface CommandPolicyResource {
  kind: "command";
  argv: string[];
  cwd: string;
  envKeys: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface GenericToolPolicyResource {
  kind: "tool";
  toolName: string;
}

export type PolicyResource =
  | FilePolicyResource
  | NetworkPolicyResource
  | CommandPolicyResource
  | GenericToolPolicyResource;

export interface PolicyRequest {
  principal: PolicyPrincipal;
  action: PolicyAction;
  resource: PolicyResource;
  normalizedInput: unknown;
  runContext: {
    runId: string;
    sessionId?: string;
    traceId?: string;
    interactive: boolean;
    toolCallId?: string;
    iteration: number;
  };
}

export interface PolicyObligation {
  type: "redact_output" | "limit_output_bytes" | "require_audit_tag" | "enforce_timeout";
  value?: unknown;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  reason: string;
  ruleVersion: string;
  matchedRuleIds?: string[];
  obligations?: PolicyObligation[];
}

export interface PolicyRule {
  id: string;
  effect: PolicyEffect;
  match(request: PolicyRequest): boolean;
  reason?: string;
  obligations?: PolicyObligation[];
}

export interface PolicyEngine {
  evaluate(request: PolicyRequest): Promise<PolicyDecision>;
}
