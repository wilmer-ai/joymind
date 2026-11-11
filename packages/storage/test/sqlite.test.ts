import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRunStore } from '../src/index.js';
import { createRunFixture } from './fixtures.js';

describe('SqliteRunStore persistence', () => {
  let directory: string;
  let filename: string;
  let stores: SqliteRunStore[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'joymind-storage-'));
    filename = join(directory, 'joymind.sqlite');
    stores = [];
  });

  afterEach(async () => {
    for (const store of stores) await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  function openStore(): SqliteRunStore {
    const store = new SqliteRunStore(filename);
    stores.push(store);
    return store;
  }

  it('retains runs, events and associated records after reopening', async () => {
    const first = openStore();
    const workspace = await first.createWorkspace('/work');
    const session = await first.createSession(workspace.id, 'Persistent');
    const run = createRunFixture(session.id, workspace.id);
    await first.createRun(run);
    await first.commit(run.id, 0, { status: 'running' }, [
      { type: 'run.started', actor: 'system', payload: { persisted: true } },
    ]);
    await first.upsertToolCall({
      id: 'tool-1', runId: run.id, toolName: 'fs.read', status: 'success', arguments: { path: 'a.txt' },
      result: {
        status: 'success', content: [{ type: 'text', text: 'contents' }],
        metadata: { durationMs: 1, truncated: false, retryable: false },
      },
      createdAt: '2025-01-01T00:00:01.000Z', updatedAt: '2025-01-01T00:00:02.000Z',
    });
    await first.createApproval({
      id: 'approval-1', runId: run.id, toolCallId: 'tool-1', decision: 'approved', scope: 'workspace',
      createdAt: '2025-01-01T00:00:01.000Z', decidedAt: '2025-01-01T00:00:02.000Z',
    });
    await first.createArtifact({
      id: 'artifact-1', runId: run.id, kind: 'text', path: '/work/a.txt', mime: 'text/plain',
      size: 8, checksum: 'checksum', createdAt: '2025-01-01T00:00:03.000Z',
    });
    await first.recordCommand(run.id, { commandId: 'pause-1', type: 'pause' });
    await first.close();

    const reopened = openStore();
    expect(await reopened.getRun(run.id)).toMatchObject({ version: 1, status: 'running' });
    expect((await reopened.listEvents(run.id))[0]?.payload).toEqual({ persisted: true });
    expect((await reopened.getToolCall('tool-1')).result?.content).toEqual([{ type: 'text', text: 'contents' }]);
    expect((await reopened.getApproval('approval-1')).decision).toBe('approved');
    expect(await reopened.listArtifacts(run.id)).toHaveLength(1);
    expect(await reopened.hasCommand(run.id, 'pause-1')).toBe(true);
  });

  it('rejects a stale writer from a second connection', async () => {
    const first = openStore();
    const second = openStore();
    const workspace = await first.createWorkspace('/work');
    const session = await first.createSession(workspace.id, 'Session');
    const run = createRunFixture(session.id, workspace.id);
    await first.createRun(run);

    await first.commit(run.id, 0, { status: 'running' }, [
      { type: 'run.started', actor: 'system', payload: {} },
    ]);
    await expect(second.commit(run.id, 0, { status: 'cancelled' }, [
      { type: 'run.cancelled', actor: 'user', payload: {} },
    ])).rejects.toMatchObject({ normalized: { code: 'conflict' } });

    expect(await second.getRun(run.id)).toMatchObject({ status: 'running', version: 1 });
    expect(await second.listEvents(run.id)).toHaveLength(1);
  });

  it('rolls back the snapshot and all events when a commit fails', async () => {
    const store = openStore();
    const workspace = await store.createWorkspace('/work');
    const session = await store.createSession(workspace.id, 'Session');
    const run = createRunFixture(session.id, workspace.id);
    await store.createRun(run);
    const circular: { self?: unknown } = {};
    circular.self = circular;

    await expect(store.commit(run.id, 0, { status: 'running' }, [
      { type: 'run.started', actor: 'system', payload: {} },
      { type: 'invalid', actor: 'system', payload: circular },
    ])).rejects.toMatchObject({ normalized: { code: 'conflict' } });
    expect(await store.getRun(run.id)).toMatchObject({ status: 'queued', version: 0 });
    expect(await store.listEvents(run.id)).toEqual([]);
  });

  it('upgrades a version 1 database without losing runs or events', async () => {
    const initial = openStore();
    const workspace = await initial.createWorkspace('/work');
    const session = await initial.createSession(workspace.id, 'Session');
    const run = createRunFixture(session.id, workspace.id);
    await initial.createRun(run);
    await initial.commit(run.id, 0, { status: 'running' }, [
      { type: 'run.started', actor: 'system', payload: { version: 1 } },
    ]);
    await initial.close();

    const legacy = new Database(filename);
    legacy.exec(`
      DROP INDEX idx_runs_parent_run_id;
      DROP INDEX idx_tool_calls_run_id;
      DROP INDEX idx_approvals_run_id;
      DROP INDEX idx_artifacts_run_id;
      ALTER TABLE runs DROP COLUMN permission_mode;
      DELETE FROM schema_migrations WHERE version IN (2, 3);
    `);
    legacy.close();

    const migrated = openStore();
    expect(await migrated.getRun(run.id)).toMatchObject({ id: run.id, version: 1, status: 'running', permissionMode: 'ask' });
    expect((await migrated.listEvents(run.id))[0]?.payload).toEqual({ version: 1 });
    const inspection = new Database(filename, { readonly: true });
    const versions = inspection.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    const indexes = inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_artifacts_run_id'").all();
    inspection.close();
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(indexes).toHaveLength(1);
  });

  it('creates the complete schema and enables WAL', async () => {
    openStore();
    const inspection = new Database(filename, { readonly: true });
    const tables = inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const journalMode = inspection.pragma('journal_mode', { simple: true });
    inspection.close();

    expect(journalMode).toBe('wal');
    expect(new Set(tables.map((table) => table.name))).toEqual(new Set([
      'workspaces', 'sessions', 'runs', 'run_events', 'messages', 'tool_calls',
      'approvals', 'artifacts', 'commands', 'schema_migrations',
    ]));
  });
});
