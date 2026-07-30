export type ApprovalDecision = "allow" | "deny";
export type ApprovalResponseScope = "once" | "session";

export interface ApprovalRecord {
  id: string;
  requestFingerprint: string;
  principalId: string;
  actionKind: string;
  resourceScope: string;
  operator: string;
  decision: ApprovalDecision;
  createdAt: string;
  reason?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface ApprovalStore {
  add(record: ApprovalRecord): Promise<void>;
  findMatching(requestFingerprint: string, principalId: string): Promise<ApprovalRecord | undefined>;
}

export interface ApprovalPrompt {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly principalId: string;
  readonly requestFingerprint: string;
  readonly actionKind: string;
  readonly resourceScope: string;
  readonly reason: string;
  readonly input: unknown;
  readonly policyEffect: "allow" | "deny" | "ask";
  readonly policyObligations?: readonly unknown[];
  readonly source?: string;
  readonly risk?: string;
  readonly normalizedResource?: string;
  readonly policyDetails?: readonly string[];
}

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: ApprovalResponseScope;
}

export type ApprovalHandler = (prompt: ApprovalPrompt) => Promise<ApprovalResponse | undefined> | ApprovalResponse | undefined;
