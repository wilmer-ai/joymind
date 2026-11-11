import type { NormalizedError, RunEvent, RunSnapshot, RunStatus } from '@joymind/core';

export interface RunState {
  snapshot?: RunSnapshot;
  events: RunEvent[];
  seenSeq: Record<number, true>;
  error?: string | undefined;
}

export interface AppState {
  runs: Record<string, RunState>;
  selectedRunId?: string;
  history: RunSnapshot[];
  historyHasMore: boolean;
}

export const initialAppState: AppState = { runs: {}, history: [], historyHasMore: false };

export type AppAction =
  | { type: 'select'; runId: string }
  | { type: 'snapshot'; snapshot: RunSnapshot }
  | { type: 'event'; event: RunEvent }
  | { type: 'history'; runs: RunSnapshot[]; hasMore: boolean; append: boolean }
  | { type: 'runError'; runId: string; message: string };

const eventStatuses: Record<string, RunStatus> = {
  'run.started': 'running',
  'run.paused': 'paused',
  'run.resumed': 'running',
  'run.cancelled': 'cancelled',
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.interrupted': 'interrupted',
  'tool.approval_required': 'waiting_for_approval',
  'approval.approved': 'running',
  'approval.rejected': 'running',
};

function mergeHistory(history: RunSnapshot[], snapshot: RunSnapshot): RunSnapshot[] {
  const exists = history.some((run) => run.id === snapshot.id);
  const next = exists
    ? history.map((run) => run.id === snapshot.id && run.version <= snapshot.version ? snapshot : run)
    : [...history, snapshot];
  return next.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function snapshotFromEvent(snapshot: RunSnapshot, event: RunEvent): RunSnapshot {
  const status = eventStatuses[event.type];
  let error: NormalizedError | undefined;
  if (event.type === 'run.failed') {
    const payload = event.payload as { error?: NormalizedError };
    error = payload.error;
  }
  if (!status && !error) return snapshot;
  return {
    ...snapshot,
    ...(status ? { status } : {}),
    ...(error ? { error } : {}),
    ...(status && ['completed', 'failed', 'cancelled'].includes(status)
      ? { finishedAt: event.occurredAt }
      : {}),
  };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  if (action.type === 'select') return { ...state, selectedRunId: action.runId };

  if (action.type === 'history') {
    const byId = new Map(state.history.map((run) => [run.id, run]));
    for (const run of action.runs) {
      const previous = byId.get(run.id);
      if (!previous || previous.version <= run.version) byId.set(run.id, run);
    }
    const history = action.append ? [...byId.values()] : action.runs;
    return {
      ...state,
      history: history.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      historyHasMore: action.hasMore,
    };
  }

  if (action.type === 'snapshot') {
    const { snapshot } = action;
    const previous = state.runs[snapshot.id] ?? { events: [], seenSeq: {} };
    if (previous.snapshot && previous.snapshot.version > snapshot.version) return state;
    return {
      ...state,
      runs: { ...state.runs, [snapshot.id]: { ...previous, snapshot, error: undefined } },
      history: mergeHistory(state.history, snapshot),
    };
  }

  if (action.type === 'runError') {
    const previous = state.runs[action.runId] ?? { events: [], seenSeq: {} };
    return {
      ...state,
      runs: { ...state.runs, [action.runId]: { ...previous, error: action.message } },
    };
  }

  const { event } = action;
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) return state;
  const previous = state.runs[event.runId] ?? { events: [], seenSeq: {} };
  if (previous.seenSeq[event.seq]) return state;
  const events = [...previous.events, event].sort((left, right) => left.seq - right.seq);
  const snapshot = previous.snapshot ? snapshotFromEvent(previous.snapshot, event) : undefined;
  const nextRun: RunState = {
    ...previous,
    ...(snapshot ? { snapshot } : {}),
    events,
    seenSeq: { ...previous.seenSeq, [event.seq]: true },
  };
  return {
    ...state,
    runs: { ...state.runs, [event.runId]: nextRun },
    ...(snapshot ? { history: mergeHistory(state.history, snapshot) } : {}),
  };
}
