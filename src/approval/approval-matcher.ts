import type { ApprovalRecord } from "./types.js";

export function isApprovalUsable(record: ApprovalRecord | undefined): record is ApprovalRecord {
  if (!record) return false;
  if (record.revokedAt !== undefined) return false;
  if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now()) return false;
  return true;
}
