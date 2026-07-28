import type { PolicyDecision, PolicyEffect, PolicyRule } from "./types.js";

const EFFECT_PRIORITY: Record<PolicyEffect, number> = {
  deny: 3,
  ask: 2,
  allow: 1,
};

export function combinePolicyDecisions(
  decisions: Array<PolicyDecision | null | undefined>,
): PolicyDecision {
  const existing = decisions.filter((decision): decision is PolicyDecision => decision !== null && decision !== undefined);
  if (existing.length === 0) {
    return {
      effect: "deny",
      reason: "No policy rule matched the request",
      ruleVersion: "v0",
    };
  }

  return existing.reduce((current, candidate) => (
    EFFECT_PRIORITY[candidate.effect] > EFFECT_PRIORITY[current.effect]
      ? candidate
      : current
  ));
}

export function decisionFromRule(rule: PolicyRule, ruleVersion: string): PolicyDecision {
  return {
    effect: rule.effect,
    reason: rule.reason ?? `Matched rule: ${rule.id}`,
    ruleVersion,
    matchedRuleIds: [rule.id],
    ...(rule.obligations !== undefined ? { obligations: rule.obligations } : {}),
  };
}
