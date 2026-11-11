import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JoymindError } from '@joymind/core';
import type { RunStore } from '@joymind/core';
import { createRunFixture } from './fixtures.js';

export function runStoreContract(name: string, createStore: () => RunStore | Promise<RunStore>): void {
  describe(name, () => {
    let store: RunStore;

    beforeEach(async () => {
      store = await createStore();
    });

    afterEach(async () => {
      await store.close();
    });

    it('creates and lists workspaces and sessions', async () => {
      const first = await store.createWorkspace('/work/first', 'First');
      const second = await store.createWorkspace('/work/second');
      const firstSession = await store.createSession(first.id, 'First session');
      const secondSession = await store.createSession(second.id, 'Second session');

      expect(await store.getWorkspace(first.id)).toEqual(first);
      expect(second.name).toBe('/work/second');
      expect(await store.getSession(firstSession.id)).toEqual(firstSession);
      expect(await store.listSessions()).toHaveLength(2);
      expect(await store.listSessions(first.id)).toEqual([firstSession]);
      expect((await store.listSessions(second.id))[0]?.id).toBe(secondSession.id);
      await expect(store.getWorkspace('missing')).rejects.toBeInstanceOf(JoymindError);
    });

    it('creates, reads and paginates runs', async () => {
      const workspace = await store.createWorkspace('/work');
      const session = await store.createSession(workspace.id, 'Session');
      const first = createRunFixture(session.id, workspace.id, 'run-1');
      const second = {
        ...createRunFixture(session.id, workspace.id, 'run-2'),
        createdAt: '2025-01-02T00:00:00.000Z',
        updatedAt: '2025-01-02T00:00:00.000Z',
      };
      await store.createRun(first);
      await store.createRun(second);

      expect(await store.getRun(first.id)).toEqual(first);
      expect((await store.listRuns()).map((run) => run.id)).toEqual(['run-2', 'run-1']);
      expect(await store.listRuns(1)).toEqual([second]);
      expect(await store.listRuns(0)).toEqual([]);
      await expect(store.createRun(first)).rejects.toMatchObject({
        normalized: { code: 'conflict' },
      });
    });

    it('commits snapshots and monotonically sequenced events atomically', async () => {
      const workspace = await store.createWorkspace('/work');
      const session = await store.createSession(workspace.id, 'Session');
      const run = createRunFixture(session.id, workspace.id);
      await store.createRun(run);

      const committed = await store.commit(run.id, 0, {
        status: 'failed',
        finishReason: 'test failure',
        finishedAt: '2025-01-01T00:01:00.000Z',
        error: { code: 'test_error', message: 'Failure', retryable: false },
      }, [
        { type: 'run.started', actor: 'system', payload: { step: 1 }, correlationId: 'request-1' },
        { type: 'run.failed', actor: 'system', payload: { reason: 'test' }, causationId: 'event-0' },
      ]);

      expect(committed.map((event) => event.seq)).toEqual([1, 2]);
      expect(committed[0]).toMatchObject({
        runId: run.id,
        type: 'run.started',
        correlationId: 'request-1',
        payload: { step: 1 },
      });
      expect(new Date(committed[0]!.occurredAt).toISOString()).toBe(committed[0]!.occurredAt);
      expect(await store.getRun(run.id)).toMatchObject({
        status: 'failed',
        version: 1,
        finishReason: 'test failure',
        error: { code: 'test_error' },
      });
      expect((await store.listEvents(run.id)).map((event) => event.id))
        .toEqual(committed.map((event) => event.id));

      await store.commit(run.id, 1, { usage: { inputTokens: 3, outputTokens: 2, toolCalls: 0, steps: 1 } }, [
        { type: 'budget.updated', actor: 'system', payload: { tokens: 5 } },
      ]);
      expect((await store.listEvents(run.id, 0, 2)).map((event) => event.seq)).toEqual([1, 2]);
      expect((await store.listEvents(run.id, 2, 1)).map((event) => event.seq)).toEqual([3]);
      expect(await store.listEvents(run.id, 3)).toEqual([]);
    });

    it('rejects stale and duplicate commits without side effects', async () => {
      const workspace = await store.createWorkspace('/work');
      const session = await store.createSession(workspace.id, 'Session');
      const run = createRunFixture(session.id, workspace.id);
      await store.createRun(run);
      await store.commit(run.id, 0, { status: 'running' }, [
        { type: 'run.started', actor: 'system', payload: {} },
      ]);

      const duplicate = store.commit(run.id, 0, { status: 'completed' }, [
        { type: 'run.completed', actor: 'system', payload: {} },
      ]);
      await expect(duplicate).rejects.toMatchObject({ normalized: { code: 'conflict' } });
      await expect(store.commit(run.id, 9, {}, [])).rejects.toMatchObject({
        normalized: { code: 'conflict' },
      });
      expect(await store.getRun(run.id)).toMatchObject({ status: 'running', version: 1 });
      expect(await store.listEvents(run.id)).toHaveLength(1);
    });

    it('upserts tool calls and creates and updates approvals', async () => {
      const workspace = await store.createWorkspace('/work');
      const session = await store.createSession(workspace.id, 'Session');
      const run = createRunFixture(session.id, workspace.id);
      await store.createRun(run);
      const requested = {
        id: 'tool-1',
        runId: run.id,
        toolName: 'fs.write',
        status: 'requested' as const,
        arguments: { path: 'result.txt', content: 'hello' },
        createdAt: '2025-01-01T00:00:01.000Z',
        updatedAt: '2025-01-01T00:00:01.000Z',
      };
      await store.upsertToolCall(requested);
      expect(await store.getToolCall(requested.id)).toEqual(requested);

      const completed = {
        ...requested,
        status: 'success' as const,
        result: {
          status: 'success' as const,
          content: [{ type: 'text' as const, text: 'done' }],
          metadata: { durationMs: 2, truncated: false, retryable: false },
        },
        updatedAt: '2025-01-01T00:00:02.000Z',
      };
      await store.upsertToolCall(completed);
      expect(await store.getToolCall(requested.id)).toEqual(completed);

      const pending = {
        id: 'approval-1',
        runId: run.id,
        toolCallId: requested.id,
        decision: 'pending' as const,
        scope: 'workspace',
        createdAt: '2025-01-01T00:00:01.500Z',
      };
      await store.createApproval(pending);
      expect(await store.getApproval(pending.id)).toEqual(pending);
      await expect(store.createApproval(pending)).rejects.toMatchObject({ normalized: { code: 'conflict' } });

      const approved = { ...pending, decision: 'approved' as const, decidedAt: '2025-01-01T00:00:03.000Z' };
      await store.updateApproval(approved);
      expect(await store.getApproval(pending.id)).toEqual(approved);
    });

    it('creates and lists artifacts', async () => {
      const workspace = await store.createWorkspace('/work');
      const session = await store.createSession(workspace.id, 'Session');
      const run = createRunFixture(session.id, workspace.id);
      await store.createRun(run);
      const artifact = {
        id: 'artifact-1',
        runId: run.id,
        kind: 'text',
        path: '/work/result.txt',
        mime: 'text/plain',
        size: 5,
        checksum: 'abc123',
        createdAt: '2025-01-01T00:00:04.000Z',
      };
      await store.createArtifact(artifact);
      expect(await store.listArtifacts(run.id)).toEqual([artifact]);
      await expect(store.createArtifact(artifact)).rejects.toMatchObject({ normalized: { code: 'conflict' } });
    });

    it('records commands idempotently per run', async () => {
      const workspace = await store.createWorkspace('/work');
      const session = await store.createSession(workspace.id, 'Session');
      const first = createRunFixture(session.id, workspace.id, 'run-1');
      const second = createRunFixture(session.id, workspace.id, 'run-2');
      await store.createRun(first);
      await store.createRun(second);
      const command = { commandId: 'command-1', type: 'pause' as const };

      expect(await store.hasCommand(first.id, command.commandId)).toBe(false);
      await store.recordCommand(first.id, command);
      await store.recordCommand(first.id, command);
      expect(await store.hasCommand(first.id, command.commandId)).toBe(true);
      expect(await store.hasCommand(second.id, command.commandId)).toBe(false);
    });

    it('does not expose mutable in-memory state', async () => {
      const workspace = await store.createWorkspace('/work');
      const session = await store.createSession(workspace.id, 'Session');
      const run = createRunFixture(session.id, workspace.id);
      await store.createRun(run);
      const snapshot = await store.getRun(run.id);
      snapshot.goal = 'mutated';
      snapshot.budget.maxSteps = 999;
      expect((await store.getRun(run.id)).goal).toBe(run.goal);
      expect((await store.getRun(run.id)).budget.maxSteps).toBe(10);
    });
  });
}
