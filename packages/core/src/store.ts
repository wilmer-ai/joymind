import type { Approval, Artifact, NewRunEvent, RunCommand, RunEvent, RunSnapshot, Session, ToolCallRecord, Workspace } from './types.js';

export interface RunStore {
  createWorkspace(rootPath: string, name?: string): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace>;
  createSession(workspaceId: string, title: string): Promise<Session>;
  getSession(id: string): Promise<Session>;
  listSessions(workspaceId?: string): Promise<Session[]>;
  createRun(run: RunSnapshot): Promise<void>;
  getRun(id: string): Promise<RunSnapshot>;
  listRuns(limit?: number): Promise<RunSnapshot[]>;
  commit(runId: string, expectedVersion: number, patch: Partial<RunSnapshot>, events: NewRunEvent[]): Promise<RunEvent[]>;
  listEvents(runId: string, afterSeq?: number, limit?: number): Promise<RunEvent[]>;
  upsertToolCall(call: ToolCallRecord): Promise<void>;
  getToolCall(id: string): Promise<ToolCallRecord>;
  createApproval(approval: Approval): Promise<void>;
  getApproval(id: string): Promise<Approval>;
  updateApproval(approval: Approval): Promise<void>;
  createArtifact(artifact: Artifact): Promise<void>;
  listArtifacts(runId: string): Promise<Artifact[]>;
  hasCommand(runId: string, commandId: string): Promise<boolean>;
  recordCommand(runId: string, command: RunCommand): Promise<void>;
  close(): Promise<void>;
}
