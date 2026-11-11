import { describe, expect, it } from 'vitest';
import type { RunEvent, RunSnapshot } from '@joymind/core';
import { appReducer, initialAppState } from './state.js';

const snapshot: RunSnapshot = {
  id: 'run-1',
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  rootRunId: 'run-1',
  agentDefinitionId: 'coding-assistant',
  mode: 'single',
  permissionMode: 'ask',
  goal: '实现桌面端',
  status: 'queued',
  version: 0,
  budget: { maxSteps: 40, maxToolCalls: 60, maxTokens: 200000, maxWallTimeSeconds: 1800, maxNoProgressSteps: 8 },
  usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, steps: 0 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function event(seq: number, type = 'message.assistant.delta', payload: unknown = { text: `事件 ${seq}` }): RunEvent {
  return {
    id: `event-${seq}`,
    runId: 'run-1',
    seq,
    type,
    occurredAt: `2026-01-01T00:00:0${seq}.000Z`,
    actor: type.startsWith('tool.') ? 'tool' : 'agent',
    payload,
  };
}

describe('appReducer', () => {
  it('按 runId + seq 去重，重复事件不会修改状态', () => {
    const withSnapshot = appReducer(initialAppState, { type: 'snapshot', snapshot });
    const withEvent = appReducer(withSnapshot, { type: 'event', event: event(1) });
    const withDuplicate = appReducer(withEvent, { type: 'event', event: { ...event(1), payload: { text: '篡改内容' } } });

    expect(withDuplicate).toBe(withEvent);
    expect(withDuplicate.runs['run-1']?.events).toHaveLength(1);
    expect(withDuplicate.runs['run-1']?.events[0]?.payload).toEqual({ text: '事件 1' });
  });

  it('接收乱序事件后仍按 seq 排序，重连重放得到同一视图', () => {
    let state = appReducer(initialAppState, { type: 'snapshot', snapshot });
    for (const item of [event(3), event(1), event(2), event(2), event(1)]) {
      state = appReducer(state, { type: 'event', event: item });
    }

    expect(state.runs['run-1']?.events.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(state.runs['run-1']?.seenSeq).toEqual({ 1: true, 2: true, 3: true });
  });

  it('运行事件同步更新快照状态，旧快照不会覆盖新状态', () => {
    let state = appReducer(initialAppState, { type: 'snapshot', snapshot });
    state = appReducer(state, { type: 'event', event: event(1, 'run.paused', {}) });
    expect(state.runs['run-1']?.snapshot?.status).toBe('paused');

    const stale = appReducer(state, { type: 'snapshot', snapshot: { ...snapshot, version: -1, status: 'running' } });
    expect(stale).toBe(state);

    const failed = appReducer(state, {
      type: 'event',
      event: event(2, 'run.failed', { error: { code: 'provider_error', message: '连接失败', retryable: true } }),
    });
    expect(failed.runs['run-1']?.snapshot?.status).toBe('failed');
    expect(failed.runs['run-1']?.snapshot?.error?.message).toBe('连接失败');
  });

  it('历史分页按 Run ID 去重，且保留较新的快照', () => {
    const newer = { ...snapshot, version: 2, status: 'completed' as const };
    let state = appReducer(initialAppState, { type: 'history', runs: [snapshot], hasMore: true, append: false });
    state = appReducer(state, { type: 'history', runs: [{ ...snapshot, status: 'failed' }, newer], hasMore: false, append: true });

    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.status).toBe('completed');
    expect(state.historyHasMore).toBe(false);
  });
});
