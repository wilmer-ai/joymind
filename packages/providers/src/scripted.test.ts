import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from './scripted.js';
import { caughtError, collect, modelRequest } from './test-server.js';

describe('ScriptedProvider', () => {
  it('consumes a general response queue', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: 'offline' },
        { type: 'tool_call', call: { id: 'call-1', name: 'fs.read', arguments: { path: 'README.md' } } },
        { type: 'usage', inputTokens: 3, outputTokens: 2 },
        { type: 'done', reason: 'tool_calls' },
      ],
      [{ type: 'done', reason: 'stop' }],
    ]);

    expect(await collect(provider.stream(modelRequest()))).toEqual([
      { type: 'text_delta', text: 'offline' },
      { type: 'tool_call', call: { id: 'call-1', name: 'fs.read', arguments: { path: 'README.md' } } },
      { type: 'usage', inputTokens: 3, outputTokens: 2 },
      { type: 'done', reason: 'tool_calls' },
    ]);
    expect(await collect(provider.stream(modelRequest()))).toEqual([{ type: 'done', reason: 'stop' }]);
    await caughtError(collect(provider.stream(modelRequest())), 'script_exhausted');
  });

  it('keeps independent response queues for each run', async () => {
    const provider = new ScriptedProvider({
      byRun: {
        'run-a': [[{ type: 'text_delta', text: 'A1' }], [{ type: 'text_delta', text: 'A2' }]],
        'run-b': [[{ type: 'text_delta', text: 'B1' }]],
      },
      runId: (request) => request.model,
    });

    expect(await collect(provider.stream({ ...modelRequest(), model: 'run-a' }))).toEqual([{ type: 'text_delta', text: 'A1' }]);
    expect(await collect(provider.stream({ ...modelRequest(), model: 'run-b' }))).toEqual([{ type: 'text_delta', text: 'B1' }]);
    expect(await collect(provider.stream({ ...modelRequest(), model: 'run-a' }))).toEqual([{ type: 'text_delta', text: 'A2' }]);
  });

  it('cancels a delayed scripted response', async () => {
    const provider = new ScriptedProvider([{
      delayMs: 5_000,
      events: [{ type: 'done', reason: 'stop' }],
    }]);
    const controller = new AbortController();
    const iterator = provider.stream(modelRequest(controller.signal))[Symbol.asyncIterator]();
    const pending = iterator.next() as Promise<unknown>;
    controller.abort();
    await caughtError(pending, 'cancelled');
  });
});
