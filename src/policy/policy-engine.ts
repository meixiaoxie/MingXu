import { combinePolicyDecisions, decisionFromRule } from "./policy-combinators.js";
import type { PolicyDecision, PolicyEngine, PolicyRequest, PolicyRule } from "./types.js";

export class BasicPolicyEngine implements PolicyEngine {
  constructor(
    private readonly rules: readonly PolicyRule[],
    private readonly ruleVersion = "v1",
  ) {}

  async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
    const matched = this.rules
      .filter((rule) => rule.match(request))
      .map((rule) => decisionFromRule(rule, this.ruleVersion));
    return combinePolicyDecisions(matched);
  }
}
