import { JoymindError } from './errors.js';
import type { RunStatus } from './types.js';

const transitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'cancelled', 'interrupted'],
  running: ['waiting_for_approval', 'waiting_for_input', 'paused', 'completed', 'failed', 'cancelled', 'interrupted'],
  waiting_for_approval: ['running', 'paused', 'cancelled', 'interrupted'],
  waiting_for_input: ['running', 'paused', 'cancelled', 'interrupted'],
  paused: ['running', 'cancelled', 'interrupted'],
  completed: [], failed: [], cancelled: [], interrupted: ['running', 'cancelled'],
};

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!transitions[from].includes(to)) {
    throw new JoymindError({ code: 'conflict', message: `Invalid run transition: ${from} → ${to}`, retryable: false });
  }
}

export function isTerminal(status: RunStatus): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status);
}
