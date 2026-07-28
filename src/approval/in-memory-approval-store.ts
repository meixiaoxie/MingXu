import type { ApprovalRecord, ApprovalStore } from "./types.js";

export class InMemoryApprovalStore implements ApprovalStore {
  readonly #records = new Map<string, ApprovalRecord>();

  async add(record: ApprovalRecord): Promise<void> {
    this.#records.set(record.id, record);
  }

  async findMatching(requestFingerprint: string): Promise<ApprovalRecord | undefined> {
    const now = Date.now();
    for (const record of this.#records.values()) {
      if (record.requestFingerprint !== requestFingerprint) continue;
      if (record.revokedAt !== undefined) continue;
      if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now) continue;
      return record;
    }
    return undefined;
  }
}
