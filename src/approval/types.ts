export type ApprovalDecision = "allow" | "deny";

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
  findMatching(requestFingerprint: string): Promise<ApprovalRecord | undefined>;
}
