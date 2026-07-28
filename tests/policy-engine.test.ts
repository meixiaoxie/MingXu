import { describe, expect, it } from "vitest";

import { combinePolicyDecisions } from "../src/policy/policy-combinators.js";
import { BasicPolicyEngine } from "../src/policy/policy-engine.js";
import type { PolicyRequest, PolicyRule } from "../src/policy/types.js";

describe("policy engine", () => {
  const baseRequest: PolicyRequest = {
    principal: { kind: "user", id: "local-user" },
    action: { kind: "tool.call", name: "echo" },
    resource: { kind: "tool", toolName: "echo" },
    normalizedInput: {},
    runContext: {
      runId: "run-1",
      interactive: false,
      iteration: 1,
    },
  };

  it("defaults to deny when no rule matches", async () => {
    const engine = new BasicPolicyEngine([]);
    const decision = await engine.evaluate(baseRequest);
    expect(decision.effect).toBe("deny");
  });

  it("uses deny > ask > allow precedence", () => {
    const result = combinePolicyDecisions([
      { effect: "allow", reason: "allow", ruleVersion: "v1" },
      { effect: "ask", reason: "ask", ruleVersion: "v1" },
      { effect: "deny", reason: "deny", ruleVersion: "v1" },
    ]);
    expect(result.effect).toBe("deny");
  });

  it("returns matched rule metadata", async () => {
    const rules: PolicyRule[] = [{
      id: "allow-echo",
      effect: "allow",
      match: () => true,
      reason: "echo is allowed",
    }];
    const engine = new BasicPolicyEngine(rules, "rules-v1");
    const decision = await engine.evaluate(baseRequest);
    expect(decision).toMatchObject({
      effect: "allow",
      reason: "echo is allowed",
      ruleVersion: "rules-v1",
      matchedRuleIds: ["allow-echo"],
    });
  });
});
