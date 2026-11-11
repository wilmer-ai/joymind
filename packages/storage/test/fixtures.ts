import type { RunSnapshot } from '@joymind/core';

export function createRunFixture(sessionId: string, workspaceId: string, id = 'run-1'): RunSnapshot {
  return {
    id,
    sessionId,
    workspaceId,
    rootRunId: id,
    agentDefinitionId: 'agent-v1',
    mode: 'single',
    permissionMode: 'ask',
    goal: `Goal for ${id}`,
    status: 'queued',
    version: 0,
    budget: {
      maxSteps: 10,
      maxToolCalls: 10,
      maxTokens: 1000,
      maxWallTimeSeconds: 60,
      maxNoProgressSteps: 3,
    },
    usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, steps: 0 },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}
