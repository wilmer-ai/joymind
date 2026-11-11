import { randomUUID } from 'node:crypto';
import type {
  Approval,
  Artifact,
  NewRunEvent,
  RunCommand,
  RunEvent,
  RunSnapshot,
  RunStore,
  Session,
  ToolCallRecord,
  Workspace,
} from '@joymind/core';
import { conflict, notFound } from './errors.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function byCreatedAt<T extends { createdAt: string; id: string }>(left: T, right: T): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export class MemoryRunStore implements RunStore {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly sessions = new Map<string, Session>();
  private readonly runs = new Map<string, RunSnapshot>();
  private readonly events = new Map<string, RunEvent[]>();
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  private readonly approvals = new Map<string, Approval>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly commands = new Map<string, RunCommand>();

  async createWorkspace(rootPath: string, name?: string): Promise<Workspace> {
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: randomUUID(),
      name: name ?? rootPath,
      rootPath,
      createdAt: now,
      lastOpenedAt: now,
    };
    this.workspaces.set(workspace.id, workspace);
    return clone(workspace);
  }

  async getWorkspace(id: string): Promise<Workspace> {
    return clone(this.workspaces.get(id) ?? notFound('Workspace', id));
  }

  async createSession(workspaceId: string, title: string): Promise<Session> {
    if (!this.workspaces.has(workspaceId)) notFound('Workspace', workspaceId);
    const now = new Date().toISOString();
    const session: Session = { id: randomUUID(), workspaceId, title, createdAt: now, updatedAt: now };
    this.sessions.set(session.id, session);
    return clone(session);
  }

  async getSession(id: string): Promise<Session> {
    return clone(this.sessions.get(id) ?? notFound('Session', id));
  }

  async listSessions(workspaceId?: string): Promise<Session[]> {
    return [...this.sessions.values()]
      .filter((session) => workspaceId === undefined || session.workspaceId === workspaceId)
      .sort(byCreatedAt)
      .map(clone);
  }

  async createRun(run: RunSnapshot): Promise<void> {
    if (this.runs.has(run.id)) conflict(`Run already exists: ${run.id}`, { runId: run.id });
    const session = this.sessions.get(run.sessionId) ?? notFound('Session', run.sessionId);
    if (!this.workspaces.has(run.workspaceId)) notFound('Workspace', run.workspaceId);
    if (session.workspaceId !== run.workspaceId) {
      conflict('Run workspace does not match its session', { runId: run.id, sessionId: run.sessionId });
    }
    if (run.parentRunId !== undefined && !this.runs.has(run.parentRunId)) notFound('Parent run', run.parentRunId);
    if (run.rootRunId !== run.id && !this.runs.has(run.rootRunId)) notFound('Root run', run.rootRunId);
    this.runs.set(run.id, clone(run));
    this.events.set(run.id, []);
  }

  async getRun(id: string): Promise<RunSnapshot> {
    return clone(this.runs.get(id) ?? notFound('Run', id));
  }

  async listRuns(limit?: number): Promise<RunSnapshot[]> {
    const runs = [...this.runs.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
    const selected = limit === undefined ? runs : runs.slice(0, Math.max(0, Math.floor(limit)));
    return selected.map(clone);
  }

  async commit(runId: string, expectedVersion: number, patch: Partial<RunSnapshot>, newEvents: NewRunEvent[]): Promise<RunEvent[]> {
    const current = this.runs.get(runId) ?? notFound('Run', runId);
    if (current.version !== expectedVersion) {
      conflict('Run version conflict', { runId, expectedVersion, actualVersion: current.version });
    }

    const updated = clone({
      ...current,
      ...patch,
      id: current.id,
      version: current.version + 1,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    });
    const history = this.events.get(runId) ?? [];
    const firstSeq = (history.at(-1)?.seq ?? 0) + 1;
    const occurredAt = new Date().toISOString();
    const committed = newEvents.map((event, index): RunEvent => clone({
      id: randomUUID(),
      runId,
      seq: firstSeq + index,
      type: event.type,
      actor: event.actor,
      payload: event.payload,
      occurredAt,
      ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
      ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    }));

    this.runs.set(runId, updated);
    history.push(...committed);
    this.events.set(runId, history);
    return clone(committed);
  }

  async listEvents(runId: string, afterSeq = 0, limit?: number): Promise<RunEvent[]> {
    if (!this.runs.has(runId)) notFound('Run', runId);
    const events = (this.events.get(runId) ?? []).filter((event) => event.seq > afterSeq);
    const selected = limit === undefined ? events : events.slice(0, Math.max(0, Math.floor(limit)));
    return selected.map(clone);
  }

  async upsertToolCall(call: ToolCallRecord): Promise<void> {
    if (!this.runs.has(call.runId)) notFound('Run', call.runId);
    this.toolCalls.set(call.id, clone(call));
  }

  async getToolCall(id: string): Promise<ToolCallRecord> {
    return clone(this.toolCalls.get(id) ?? notFound('Tool call', id));
  }

  async createApproval(approval: Approval): Promise<void> {
    if (this.approvals.has(approval.id)) conflict(`Approval already exists: ${approval.id}`, { approvalId: approval.id });
    this.validateApproval(approval);
    this.approvals.set(approval.id, clone(approval));
  }

  async getApproval(id: string): Promise<Approval> {
    return clone(this.approvals.get(id) ?? notFound('Approval', id));
  }

  async updateApproval(approval: Approval): Promise<void> {
    if (!this.approvals.has(approval.id)) notFound('Approval', approval.id);
    this.validateApproval(approval);
    this.approvals.set(approval.id, clone(approval));
  }

  async createArtifact(artifact: Artifact): Promise<void> {
    if (this.artifacts.has(artifact.id)) conflict(`Artifact already exists: ${artifact.id}`, { artifactId: artifact.id });
    if (!this.runs.has(artifact.runId)) notFound('Run', artifact.runId);
    this.artifacts.set(artifact.id, clone(artifact));
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    if (!this.runs.has(runId)) notFound('Run', runId);
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.runId === runId)
      .sort(byCreatedAt)
      .map(clone);
  }

  async hasCommand(runId: string, commandId: string): Promise<boolean> {
    return this.commands.has(this.commandKey(runId, commandId));
  }

  async recordCommand(runId: string, command: RunCommand): Promise<void> {
    if (!this.runs.has(runId)) notFound('Run', runId);
    const key = this.commandKey(runId, command.commandId);
    if (!this.commands.has(key)) this.commands.set(key, clone(command));
  }

  async close(): Promise<void> {}

  private validateApproval(approval: Approval): void {
    if (!this.runs.has(approval.runId)) notFound('Run', approval.runId);
    const toolCall = this.toolCalls.get(approval.toolCallId) ?? notFound('Tool call', approval.toolCallId);
    if (toolCall.runId !== approval.runId) {
      conflict('Approval run does not match its tool call', { approvalId: approval.id, toolCallId: approval.toolCallId });
    }
  }

  private commandKey(runId: string, commandId: string): string {
    return `${runId}\0${commandId}`;
  }
}
