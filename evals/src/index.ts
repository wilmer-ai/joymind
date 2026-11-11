import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultAgent } from '@joymind/core';
import { createJoymindRuntime } from '@joymind/runtime';

const started = Date.now();
const workspace = await mkdtemp(join(tmpdir(), 'joymind-eval-'));
const context = await createJoymindRuntime({
  dbPath: join(workspace, 'eval.db'),
  recover: false,
  scriptedResponses: [
    [{ type: 'tool_call', call: { id: 'eval-write', name: 'fs.write', arguments: { path: 'eval.txt', content: 'eval-ok' } } }],
    [{ type: 'text_delta', text: 'done' }, { type: 'usage', inputTokens: 20, outputTokens: 5 }, { type: 'done', reason: 'stop' }],
  ],
});
let failures = 0;
try {
  const run = await context.runtime.start({ workspacePath: workspace, goal: 'Create eval.txt', agent: structuredClone(defaultAgent) });
  for await (const event of context.runtime.events(run.id)) {
    if (event.type === 'tool.approval_required') {
      await context.runtime.command(run.id, { commandId: randomUUID(), type: 'approve', approvalId: (event.payload as { approvalId: string }).approvalId });
    }
    if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) break;
  }
  const final = await context.runtime.get(run.id);
  const content = await readFile(join(workspace, 'eval.txt'), 'utf8');
  const passed = final.status === 'completed' && content === 'eval-ok' && final.usage.toolCalls === 1;
  if (!passed) failures += 1;
  console.log(JSON.stringify({ evalVersion: 'p0-v1', agentVersion: defaultAgent.metadata.version, provider: 'scripted', cases: 1, passed: passed ? 1 : 0, failed: failures, durationMs: Date.now() - started, usage: final.usage }, null, 2));
} finally {
  await context.close();
}
process.exitCode = failures === 0 ? 0 : 1;
