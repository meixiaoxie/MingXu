import type { SessionDocument, SessionSummary, SessionWriteResult } from "./types.js";

export interface SessionStore {
  createSession(input?: { sessionId?: string; title?: string }): Promise<SessionDocument>;
  getSession(sessionId: string): Promise<SessionDocument | undefined>;
  getRequiredSession?(sessionId: string): Promise<SessionDocument>;
  saveSession(document: SessionDocument, expectedRevision?: number): Promise<SessionWriteResult>;
  listRecentSessions(limit?: number): Promise<SessionSummary[]>;
  archiveSession(sessionId: string, expectedRevision?: number): Promise<SessionWriteResult>;
  deleteSession(sessionId: string, expectedRevision?: number): Promise<SessionWriteResult>;
  recoverInterruptedRuns(now?: string): Promise<number>;
}
