import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { JoymindError } from '@joymind/core';
import type {
  Approval,
  Artifact,
  NewRunEvent,
  NormalizedError,
  RunCommand,
  RunEvent,
  RunSnapshot,
  RunStore,
  Session,
  ToolCallRecord,
  ToolResult,
  Workspace,
} from '@joymind/core';
import { conflict, notFound } from './errors.js';

interface Migration {
  version: number;
  sql: string;
}

interface JsonEnvelope<T> {
  schemaVersion: number;
  value: T;
}

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  last_opened_at: string;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  session_id: string;
  workspace_id: string;
  parent_run_id: string | null;
  root_run_id: string;
  agent_definition_id: string;
  mode: RunSnapshot['mode'];
  permission_mode: RunSnapshot['permissionMode'];
  goal: string;
  status: RunSnapshot['status'];
  version: number;
  budget_json: string;
  usage_json: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  finish_reason: string | null;
  error_json: string | null;
}

interface EventRow {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  actor: RunEvent['actor'];
  payload_json: string;
  occurred_at: string;
  correlation_id: string | null;
  causation_id: string | null;
}

interface ToolCallRow {
  id: string;
  run_id: string;
  tool_name: string;
  status: ToolCallRecord['status'];
  arguments_json: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  tool_call_id: string;
  decision: Approval['decision'];
  scope: string;
  created_at: string;
  decided_at: string | null;
  reason: string | null;
}

interface ArtifactRow {
  id: string;
  run_id: string;
  kind: string;
  path: string;
  mime: string;
  size: number;
  checksum: string;
  created_at: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        parent_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        root_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        agent_definition_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        budget_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        finish_reason TEXT,
        error_json TEXT
      );
      CREATE TABLE run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        correlation_id TEXT,
        causation_id TEXT,
        UNIQUE (run_id, seq)
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content_ref TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
        decision TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        reason TEXT
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE commands (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        command_id TEXT NOT NULL,
        command_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, command_id)
      );
      CREATE INDEX idx_sessions_workspace_id ON sessions(workspace_id);
      CREATE INDEX idx_runs_session_id ON runs(session_id);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE INDEX idx_runs_parent_run_id ON runs(parent_run_id);
      CREATE INDEX idx_tool_calls_run_id ON tool_calls(run_id);
      CREATE INDEX idx_approvals_run_id ON approvals(run_id);
      CREATE INDEX idx_artifacts_run_id ON artifacts(run_id);
    `,
  },
  {
    version: 3,
    sql: "ALTER TABLE runs ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask';",
  },
];

function encodeJson(value: unknown): string {
  return JSON.stringify({ schemaVersion: 1, value });
}

function decodeJson<T>(json: string): T {
  return (JSON.parse(json) as JsonEnvelope<T>).value;
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: RunRow): RunSnapshot {
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    rootRunId: row.root_run_id,
    agentDefinitionId: row.agent_definition_id,
    mode: row.mode,
    permissionMode: row.permission_mode,
    goal: row.goal,
    status: row.status,
    version: row.version,
    budget: decodeJson<RunSnapshot['budget']>(row.budget_json),
    usage: decodeJson<RunSnapshot['usage']>(row.usage_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.finish_reason === null ? {} : { finishReason: row.finish_reason }),
    ...(row.error_json === null ? {} : { error: decodeJson<NormalizedError>(row.error_json) }),
  };
}

function toEvent(row: EventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    type: row.type,
    actor: row.actor,
    payload: decodeJson(row.payload_json),
    occurredAt: row.occurred_at,
    ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
    ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
  };
}

function toToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    runId: row.run_id,
    toolName: row.tool_name,
    status: row.status,
    arguments: decodeJson(row.arguments_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.result_json === null ? {} : { result: decodeJson<ToolResult>(row.result_json) }),
  };
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    decision: row.decision,
    scope: row.scope,
    createdAt: row.created_at,
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
    ...(row.reason === null ? {} : { reason: row.reason }),
  };
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    path: row.path,
    mime: row.mime,
    size: row.size,
    checksum: row.checksum,
    createdAt: row.created_at,
  };
}

export class SqliteRunStore implements RunStore {
  private readonly db: Database.Database;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  async createWorkspace(rootPath: string, name?: string): Promise<Workspace> {
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: randomUUID(),
      name: name ?? rootPath,
      rootPath,
      createdAt: now,
      lastOpenedAt: now,
    };
    this.db.prepare(`
      INSERT INTO workspaces (id, name, root_path, created_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(workspace.id, workspace.name, workspace.rootPath, workspace.createdAt, workspace.lastOpenedAt);
    return workspace;
  }

  async getWorkspace(id: string): Promise<Workspace> {
    return toWorkspace(this.requireWorkspace(id));
  }

  async createSession(workspaceId: string, title: string): Promise<Session> {
    this.requireWorkspace(workspaceId);
    const now = new Date().toISOString();
    const session: Session = { id: randomUUID(), workspaceId, title, createdAt: now, updatedAt: now };
    this.db.prepare(`
      INSERT INTO sessions (id, workspace_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(session.id, session.workspaceId, session.title, session.createdAt, session.updatedAt);
    return session;
  }

  async getSession(id: string): Promise<Session> {
    return toSession(this.requireSession(id));
  }

  async listSessions(workspaceId?: string): Promise<Session[]> {
    const rows = workspaceId === undefined
      ? this.db.prepare('SELECT * FROM sessions ORDER BY created_at, id').all() as SessionRow[]
      : this.db.prepare('SELECT * FROM sessions WHERE workspace_id = ? ORDER BY created_at, id').all(workspaceId) as SessionRow[];
    return rows.map(toSession);
  }

  async createRun(run: RunSnapshot): Promise<void> {
    const session = this.requireSession(run.sessionId);
    this.requireWorkspace(run.workspaceId);
    if (session.workspace_id !== run.workspaceId) {
      conflict('Run workspace does not match its session', { runId: run.id, sessionId: run.sessionId });
    }
    if (run.parentRunId !== undefined) this.requireRun(run.parentRunId);
    if (run.rootRunId !== run.id) this.requireRun(run.rootRunId);
    this.asConflict(() => {
      this.db.prepare(`
        INSERT INTO runs (
          id, session_id, workspace_id, parent_run_id, root_run_id, agent_definition_id,
          mode, permission_mode, goal, status, version, budget_json, usage_json, created_at, updated_at,
          started_at, finished_at, finish_reason, error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id, run.sessionId, run.workspaceId, run.parentRunId ?? null, run.rootRunId,
        run.agentDefinitionId, run.mode, run.permissionMode, run.goal, run.status, run.version,
        encodeJson(run.budget), encodeJson(run.usage), run.createdAt, run.updatedAt,
        run.startedAt ?? null, run.finishedAt ?? null, run.finishReason ?? null,
        run.error === undefined ? null : encodeJson(run.error),
      );
    }, `Could not create run: ${run.id}`);
  }

  async getRun(id: string): Promise<RunSnapshot> {
    return toRun(this.requireRun(id));
  }

  async listRuns(limit?: number): Promise<RunSnapshot[]> {
    const normalizedLimit = this.normalizeLimit(limit);
    const rows = normalizedLimit === undefined
      ? this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC').all() as RunRow[]
      : this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?').all(normalizedLimit) as RunRow[];
    return rows.map(toRun);
  }

  async commit(runId: string, expectedVersion: number, patch: Partial<RunSnapshot>, newEvents: NewRunEvent[]): Promise<RunEvent[]> {
    return this.asConflict(() => this.db.transaction((): RunEvent[] => {
      const currentRow = this.requireRun(runId);
      if (currentRow.version !== expectedVersion) {
        conflict('Run version conflict', { runId, expectedVersion, actualVersion: currentRow.version });
      }
      const current = toRun(currentRow);
      const updated: RunSnapshot = {
        ...current,
        ...patch,
        id: current.id,
        version: current.version + 1,
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      };
      const result = this.db.prepare(`
        UPDATE runs SET
          session_id = ?, workspace_id = ?, parent_run_id = ?, root_run_id = ?,
          agent_definition_id = ?, mode = ?, goal = ?, status = ?, version = ?,
          budget_json = ?, usage_json = ?, created_at = ?, updated_at = ?,
          started_at = ?, finished_at = ?, finish_reason = ?, error_json = ?
        WHERE id = ? AND version = ?
      `).run(
        updated.sessionId, updated.workspaceId, updated.parentRunId ?? null, updated.rootRunId,
        updated.agentDefinitionId, updated.mode, updated.goal, updated.status, updated.version,
        encodeJson(updated.budget), encodeJson(updated.usage), updated.createdAt, updated.updatedAt,
        updated.startedAt ?? null, updated.finishedAt ?? null, updated.finishReason ?? null,
        updated.error === undefined ? null : encodeJson(updated.error), runId, expectedVersion,
      );
      if (result.changes !== 1) conflict('Run version conflict', { runId, expectedVersion });

      const sequence = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM run_events WHERE run_id = ?')
        .get(runId) as { max_seq: number };
      const occurredAt = new Date().toISOString();
      const committed = newEvents.map((event, index): RunEvent => ({
        id: randomUUID(),
        runId,
        seq: sequence.max_seq + index + 1,
        type: event.type,
        actor: event.actor,
        payload: event.payload,
        occurredAt,
        ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
        ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
      }));
      const insert = this.db.prepare(`
        INSERT INTO run_events (
          id, run_id, seq, type, actor, payload_json, occurred_at, correlation_id, causation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of committed) {
        insert.run(
          event.id, event.runId, event.seq, event.type, event.actor, encodeJson(event.payload),
          event.occurredAt, event.correlationId ?? null, event.causationId ?? null,
        );
      }
      return committed;
    }).immediate(), `Could not commit run: ${runId}`);
  }

  async listEvents(runId: string, afterSeq = 0, limit?: number): Promise<RunEvent[]> {
    this.requireRun(runId);
    const normalizedLimit = this.normalizeLimit(limit);
    const rows = normalizedLimit === undefined
      ? this.db.prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq').all(runId, afterSeq) as EventRow[]
      : this.db.prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(runId, afterSeq, normalizedLimit) as EventRow[];
    return rows.map(toEvent);
  }

  async upsertToolCall(call: ToolCallRecord): Promise<void> {
    this.requireRun(call.runId);
    this.asConflict(() => {
      this.db.prepare(`
        INSERT INTO tool_calls (id, run_id, tool_name, status, arguments_json, result_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          run_id = excluded.run_id,
          tool_name = excluded.tool_name,
          status = excluded.status,
          arguments_json = excluded.arguments_json,
          result_json = excluded.result_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        call.id, call.runId, call.toolName, call.status, encodeJson(call.arguments),
        call.result === undefined ? null : encodeJson(call.result), call.createdAt, call.updatedAt,
      );
    }, `Could not upsert tool call: ${call.id}`);
  }

  async getToolCall(id: string): Promise<ToolCallRecord> {
    const row = this.db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as ToolCallRow | undefined;
    return toToolCall(row ?? notFound('Tool call', id));
  }

  async createApproval(approval: Approval): Promise<void> {
    this.validateApproval(approval);
    this.asConflict(() => {
      this.db.prepare(`
        INSERT INTO approvals (id, run_id, tool_call_id, decision, scope, created_at, decided_at, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        approval.id, approval.runId, approval.toolCallId, approval.decision, approval.scope,
        approval.createdAt, approval.decidedAt ?? null, approval.reason ?? null,
      );
    }, `Could not create approval: ${approval.id}`);
  }

  async getApproval(id: string): Promise<Approval> {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
    return toApproval(row ?? notFound('Approval', id));
  }

  async updateApproval(approval: Approval): Promise<void> {
    this.requireApproval(approval.id);
    this.validateApproval(approval);
    this.asConflict(() => {
      this.db.prepare(`
        UPDATE approvals SET run_id = ?, tool_call_id = ?, decision = ?, scope = ?,
          created_at = ?, decided_at = ?, reason = ?
        WHERE id = ?
      `).run(
        approval.runId, approval.toolCallId, approval.decision, approval.scope,
        approval.createdAt, approval.decidedAt ?? null, approval.reason ?? null, approval.id,
      );
    }, `Could not update approval: ${approval.id}`);
  }

  async createArtifact(artifact: Artifact): Promise<void> {
    this.requireRun(artifact.runId);
    this.asConflict(() => {
      this.db.prepare(`
        INSERT INTO artifacts (id, run_id, kind, path, mime, size, checksum, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.id, artifact.runId, artifact.kind, artifact.path, artifact.mime,
        artifact.size, artifact.checksum, artifact.createdAt,
      );
    }, `Could not create artifact: ${artifact.id}`);
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    this.requireRun(runId);
    const rows = this.db.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, id').all(runId) as ArtifactRow[];
    return rows.map(toArtifact);
  }

  async hasCommand(runId: string, commandId: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 AS present FROM commands WHERE run_id = ? AND command_id = ?')
      .get(runId, commandId) as { present: number } | undefined;
    return row !== undefined;
  }

  async recordCommand(runId: string, command: RunCommand): Promise<void> {
    this.requireRun(runId);
    this.asConflict(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO commands (run_id, command_id, command_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(runId, command.commandId, encodeJson(command), new Date().toISOString());
    }, `Could not record command: ${command.commandId}`);
  }

  async close(): Promise<void> {
    if (this.db.open) this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
        .map((row) => row.version),
    );
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
      }).immediate();
    }
  }

  private requireWorkspace(id: string): WorkspaceRow {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
    return row ?? notFound('Workspace', id);
  }

  private requireSession(id: string): SessionRow {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ?? notFound('Session', id);
  }

  private requireRun(id: string): RunRow {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ?? notFound('Run', id);
  }

  private requireApproval(id: string): ApprovalRow {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
    return row ?? notFound('Approval', id);
  }

  private validateApproval(approval: Approval): void {
    this.requireRun(approval.runId);
    const row = this.db.prepare('SELECT run_id FROM tool_calls WHERE id = ?').get(approval.toolCallId) as { run_id: string } | undefined;
    if (row === undefined) notFound('Tool call', approval.toolCallId);
    if (row.run_id !== approval.runId) {
      conflict('Approval run does not match its tool call', { approvalId: approval.id, toolCallId: approval.toolCallId });
    }
  }

  private asConflict<T>(operation: () => T, message: string): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof JoymindError) throw error;
      return conflict(message, undefined, error);
    }
  }

  private normalizeLimit(limit: number | undefined): number | undefined {
    if (limit === undefined || limit === Number.POSITIVE_INFINITY) return undefined;
    if (!Number.isFinite(limit)) return 0;
    return Math.max(0, Math.floor(limit));
  }
}
