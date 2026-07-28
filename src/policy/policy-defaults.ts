import type { PolicyRequest, PolicyRule } from "./types.js";

export function createAllowAllRule(id = "allow-all-tools"): PolicyRule {
  return {
    id,
    effect: "allow",
    match: () => true,
    reason: "Default development allow rule matched",
  };
}

export function createReadFileRootRule(root: string, id = "allow-readfile-root"): PolicyRule {
  const normalizedRoot = normalizePath(root);
  return {
    id,
    effect: "allow",
    match: (request: PolicyRequest) => request.action.kind === "file.read"
      && request.resource.kind === "file"
      && normalizePath(request.resource.resolvedPath).startsWith(normalizedRoot),
    reason: `Read access allowed inside ${root}`,
  };
}

export function createDefaultNonInteractiveAskRule(id = "ask-command-exec"): PolicyRule {
  return {
    id,
    effect: "ask",
    match: (request: PolicyRequest) => request.action.kind === "command.exec",
    reason: "Command execution requires approval by default",
  };
}

export function applyNonInteractiveAskFallback(
  request: PolicyRequest,
  decision: {
    effect: "allow" | "deny" | "ask";
    reason: string;
    ruleVersion: string;
    matchedRuleIds?: string[];
    obligations?: { type: "redact_output" | "limit_output_bytes" | "require_audit_tag" | "enforce_timeout"; value?: unknown }[];
  },
) {
  if (decision.effect !== "ask" || request.runContext.interactive) {
    return decision;
  }
  return {
    ...decision,
    effect: "deny" as const,
    reason: `${decision.reason} (non-interactive runs deny approval requests by default)`,
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").toLowerCase();
}
