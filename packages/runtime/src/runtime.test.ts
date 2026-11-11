import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { MemoryRunStore } from '@joymind/storage';
import { DefaultAgentRuntime, defaultAgent, type AgentDefinition, type ModelProvider, type PermissionMode, type RunEvent, type ToolDefinition } from '@joymind/core';

function agentFor(provider: string): AgentDefinition {
  const agent = structuredClone(defaultAgent);
  agent.spec.model.provider = provider;
  agent.spec.model.model = 'test';
  agent.spec.tools.allow = ['test.write'];
  return agent;
}

async function waitFor(runId: string, runtime: DefaultAgentRuntime, status: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if ((await runtime.get(runId)).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} did not reach ${status}: ${JSON.stringify(await runtime.get(runId))}`);
}

async function waitForTool(store: MemoryRunStore, toolCallId: string, status: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if ((await store.getToolCall(toolCallId)).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Tool call ${toolCallId} did not reach ${status}`);
}

describe('DefaultAgentRuntime', () => {
  it('waits for approval and resumes the original tool call exactly once', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'joymind-core-'));
    const store = new MemoryRunStore();
    let providerCalls = 0;
    let executions = 0;
    const provider: ModelProvider = {
      capabilities: async () => ({ streaming: true, toolCalling: true, structuredOutput: false, vision: false }),
      async *stream() {
        providerCalls += 1;
        if (providerCalls === 1) yield { type: 'tool_call', call: { id: 'call-1', name: 'test.write', arguments: { path: 'result.txt', content: 'verified' } } };
        else yield { type: 'text_delta', text: 'done' };
        yield { type: 'usage', inputTokens: 10, outputTokens: 2 };
        yield { type: 'done', reason: 'stop' };
      },
    };
    const tool: ToolDefinition<{ path: string; content: string }, string> = {
      name: 'test.write', version: '1', description: 'write', inputSchema: z.object({ path: z.string(), content: z.string() }), jsonSchema: {},
      risk: 'write', capabilities: ['fs.write'], idempotency: 'unknown',
      execute: async (input, context) => { executions += 1; const { writeFile } = await import('node:fs/promises'); await writeFile(join(context.workspacePath, input.path), input.content); return input.content; },
    };
    const runtime = new DefaultAgentRuntime({ store, providers: { test: provider }, tools: [tool] });
    const run = await runtime.start({ workspacePath: workspace, goal: 'write a file', agent: agentFor('test') });
    await waitFor(run.id, runtime, 'waiting_for_approval');
    expect(executions).toBe(0);
    const events = await store.listEvents(run.id);
    const approvalEvent = events.find((event) => event.type === 'tool.approval_required');
    const approvalPayload = approvalEvent?.payload as { approvalId: string; toolCallId: string };
    const approvalId = approvalPayload.approvalId;
    expect(approvalPayload.toolCallId).not.toBe('call-1');
    expect((await store.getToolCall(approvalPayload.toolCallId)).runId).toBe(run.id);
    await runtime.command(run.id, { commandId: 'approve-once', type: 'approve', approvalId });
    await waitFor(run.id, runtime, 'completed');
    expect(executions).toBe(1);
    expect(providerCalls).toBe(2);
    expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('verified');
    expect((await runtime.get(run.id)).usage.toolCalls).toBe(1);
    expect((await runtime.command(run.id, { commandId: 'approve-once', type: 'approve', approvalId })).status).toBe('completed');
  });

  it('replays ordered events and supports cancellation', async () => {
    const store = new MemoryRunStore();
    const provider: ModelProvider = {
      capabilities: async () => ({ streaming: true, toolCalling: true, structuredOutput: false, vision: false }),
      async *stream(request) {
        yield { type: 'text_delta', text: 'working' };
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          request.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
        });
      },
    };
    const runtime = new DefaultAgentRuntime({ store, providers: { test: provider }, tools: [] });
    const run = await runtime.start({ workspacePath: tmpdir(), goal: 'wait', agent: agentFor('test') });
    const received: RunEvent[] = [];
    const reading = (async () => {
      for await (const event of runtime.events(run.id)) {
        received.push(event);
        if (event.type === 'run.cancelled') break;
      }
    })();
    await waitFor(run.id, runtime, 'running');
    await runtime.command(run.id, { commandId: randomUUID(), type: 'cancel' });
    await reading;
    expect(received.at(-1)?.type).toBe('run.cancelled');
    expect((await runtime.get(run.id)).status).toBe('cancelled');
    const persisted = await store.listEvents(run.id);
    expect(persisted.map((event) => event.seq)).toEqual(persisted.map((_, index) => index + 1));
    expect(persisted.some((event) => event.type === 'run.cancelled')).toBe(true);
  });
});

describe('permission modes', () => {
  async function startPermissionRun(mode: PermissionMode, permission?: unknown) {
    const workspace = await mkdtemp(join(tmpdir(), 'joymind-permissions-'));
    const store = new MemoryRunStore();
    let providerCalls = 0;
    let receivedArguments: unknown;
    const provider: ModelProvider = {
      capabilities: async () => ({ streaming: true, toolCalling: true, structuredOutput: false, vision: false }),
      async *stream() {
        providerCalls += 1;
        if (providerCalls === 1) yield { type: 'tool_call', call: { id: 'provider-call', name: 'test.write', arguments: {
          path: 'result.txt', content: mode, ...(permission === undefined ? {} : { __joymind_permission: permission }),
        } } };
        else yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', reason: 'stop' };
      },
    };
    const tool: ToolDefinition<{ path: string; content: string }, string> = {
      name: 'test.write', version: '1', description: 'write', inputSchema: z.object({ path: z.string(), content: z.string() }).strict(), jsonSchema: {},
      risk: 'write', capabilities: ['fs.write'], idempotency: 'unknown',
      execute: async (input, context) => {
        receivedArguments = input;
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(context.workspacePath, input.path), input.content);
        return input.content;
      },
    };
    const runtime = new DefaultAgentRuntime({ store, providers: { test: provider }, tools: [tool] });
    const agent = agentFor('test');
    agent.spec.permissions.mode = mode;
    const run = await runtime.start({ workspacePath: workspace, goal: 'write with selected permission', agent });
    return { runtime, store, run, workspace, getArguments: () => receivedArguments };
  }

  it('auto executes only an explicit valid assessment and strips reserved arguments', async () => {
    const context = await startPermissionRun('auto', { decision: 'execute', reason: 'User requested this exact file' });
    await waitFor(context.run.id, context.runtime, 'completed');
    expect(context.getArguments()).toEqual({ path: 'result.txt', content: 'auto' });
    expect(await readFile(join(context.workspace, 'result.txt'), 'utf8')).toBe('auto');
    const requested = (await context.store.listEvents(context.run.id)).find((event) => event.type === 'tool.requested');
    expect(requested?.payload).toMatchObject({ permissionMode: 'auto', assessment: { decision: 'execute' } });
    expect(JSON.stringify(requested?.payload)).not.toContain('__joymind_permission');
    expect((await context.runtime.get(context.run.id)).permissionMode).toBe('auto');
  });

  it('auto fails closed when the assessment is missing or invalid', async () => {
    for (const assessment of [undefined, { decision: 'execute', unexpected: true }]) {
      const context = await startPermissionRun('auto', assessment);
      await waitFor(context.run.id, context.runtime, 'waiting_for_approval');
      expect(context.getArguments()).toBeUndefined();
      await expect(readFile(join(context.workspace, 'result.txt'), 'utf8')).rejects.toThrow();
    }
  });

  it('autonomous executes without creating an approval while retaining the audit mode', async () => {
    const context = await startPermissionRun('autonomous');
    await waitFor(context.run.id, context.runtime, 'completed');
    expect(await readFile(join(context.workspace, 'result.txt'), 'utf8')).toBe('autonomous');
    expect((await context.store.listEvents(context.run.id)).some((event) => event.type === 'tool.approval_required')).toBe(false);
    expect((await context.runtime.get(context.run.id)).permissionMode).toBe('autonomous');
  });
});

describe('recovery safety', () => {
  it('marks interrupted side effects unknown and refuses unsafe automatic resume', async () => {
    const store = new MemoryRunStore();
    const workspace = await store.createWorkspace(tmpdir());
    const session = await store.createSession(workspace.id, 'recovery');
    const now = new Date().toISOString();
    await store.createRun({
      id: 'recover-run', sessionId: session.id, workspaceId: workspace.id, rootRunId: 'recover-run',
      agentDefinitionId: 'coding-assistant', mode: 'single', permissionMode: 'ask', goal: 'recover', status: 'running', version: 0,
      budget: defaultAgent.spec.budget, usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, steps: 0 }, createdAt: now, updatedAt: now,
    });
    await store.upsertToolCall({ id: 'unknown-call', runId: 'recover-run', toolName: 'fs.write', status: 'running', arguments: {}, createdAt: now, updatedAt: now });
    await store.commit('recover-run', 0, {}, [
      { type: 'run.started', actor: 'system', payload: { goal: 'recover', agent: agentFor('test') } },
      { type: 'tool.started', actor: 'tool', payload: { toolCallId: 'unknown-call' } },
    ]);
    const runtime = new DefaultAgentRuntime({ store, providers: {}, tools: [] });
    await runtime.recoverInterrupted();
    expect((await store.getToolCall('unknown-call')).status).toBe('unknown');
    expect((await runtime.get('recover-run')).status).toBe('interrupted');
    await expect(runtime.command('recover-run', { commandId: 'unsafe-resume', type: 'resume' })).rejects.toThrow('unknown tool side effects');
  });
});


describe('pause and budget', () => {
  it('serializes concurrent resume commands and keeps one executor', async () => {
    const store = new MemoryRunStore();
    let release: () => void = () => undefined;
    let providerCalls = 0;
    const provider: ModelProvider = {
      capabilities: async () => ({ streaming: true, toolCalling: true, structuredOutput: false, vision: false }),
      async *stream() {
        providerCalls += 1;
        yield { type: 'text_delta', text: 'paused text' };
        await new Promise<void>((resolve) => { release = resolve; });
        yield { type: 'done', reason: 'stop' };
      },
    };
    const runtime = new DefaultAgentRuntime({ store, providers: { test: provider }, tools: [] });
    const run = await runtime.start({ workspacePath: tmpdir(), goal: 'pause', agent: agentFor('test') });
    await waitFor(run.id, runtime, 'running');
    await runtime.command(run.id, { commandId: 'pause-1', type: 'pause' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await runtime.get(run.id)).status).toBe('paused');
    const resumes = await Promise.allSettled([
      runtime.command(run.id, { commandId: 'resume-1', type: 'resume' }),
      runtime.command(run.id, { commandId: 'resume-1', type: 'resume' }),
      runtime.command(run.id, { commandId: 'resume-2', type: 'resume' }),
    ]);
    expect(resumes.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    await waitFor(run.id, runtime, 'completed');
    expect(providerCalls).toBe(1);
  });
});


describe('runtime review regressions', () => {
  it('generates distinct internal IDs for identical provider call IDs across runs', async () => {
    const store = new MemoryRunStore();
    const providerCalls = new Map<string, number>();
    const provider: ModelProvider = {
      capabilities: async () => ({ streaming: true, toolCalling: true, structuredOutput: false, vision: false }),
      async *stream(request) {
        const goal = request.messages.find((message) => message.role === 'user')?.content ?? '';
        const count = (providerCalls.get(goal) ?? 0) + 1;
        providerCalls.set(goal, count);
        if (count === 1) yield { type: 'tool_call', call: { id: 'shared-provider-id', name: 'test.write', arguments: { content: goal } } };
        else yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', reason: 'stop' };
      },
    };
    const tool: ToolDefinition<{ content: string }, string> = {
      name: 'test.write', version: '1', description: 'write', inputSchema: z.object({ content: z.string() }), jsonSchema: {},
      risk: 'write', capabilities: ['fs.write'], idempotency: 'unknown', execute: async (input) => input.content,
    };
    const runtime = new DefaultAgentRuntime({ store, providers: { test: provider }, tools: [tool] });
    const first = await runtime.start({ workspacePath: tmpdir(), goal: 'first', agent: agentFor('test') });
    const second = await runtime.start({ workspacePath: tmpdir(), goal: 'second', agent: agentFor('test') });
    await Promise.all([waitFor(first.id, runtime, 'waiting_for_approval'), waitFor(second.id, runtime, 'waiting_for_approval')]);
    const approvalIds: string[] = [];
    const toolCallIds: string[] = [];
    for (const run of [first, second]) {
      const event = (await store.listEvents(run.id)).find((candidate) => candidate.type === 'tool.approval_required');
      const payload = event?.payload as { approvalId: string; toolCallId: string };
      approvalIds.push(payload.approvalId);
      toolCallIds.push(payload.toolCallId);
    }
    expect(toolCallIds[0]).not.toBe('shared-provider-id');
    expect(toolCallIds[1]).not.toBe('shared-provider-id');
    expect(new Set(toolCallIds).size).toBe(2);
    await runtime.command(first.id, { commandId: 'approve-first', type: 'approve', approvalId: approvalIds[0]! });
    await runtime.command(second.id, { commandId: 'approve-second', type: 'approve', approvalId: approvalIds[1]! });
    await Promise.all([waitFor(first.id, runtime, 'completed'), waitFor(second.id, runtime, 'completed')]);
  });

  it('resumes a paused approval without recreating it and rejects decisions while paused', async () => {
    const store = new MemoryRunStore();
    let providerCalls = 0;
    let executions = 0;
    const provider: ModelProvider = {
      capabilities: async () => ({ streaming: true, toolCalling: true, structuredOutput: false, vision: false }),
      async *stream() {
        providerCalls += 1;
        if (providerCalls === 1) yield { type: 'tool_call', call: { id: 'provider-call', name: 'test.write', arguments: { content: 'approved' } } };
        else yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', reason: 'stop' };
      },
    };
    const tool: ToolDefinition<{ content: string }, string> = {
      name: 'test.write', version: '1', description: 'write', inputSchema: z.object({ content: z.string() }), jsonSchema: {},
      risk: 'write', capabilities: ['fs.write'], idempotency: 'unknown', execute: async (input) => { executions += 1; return input.content; },
    };
    const runtime = new DefaultAgentRuntime({ store, providers: { test: provider }, tools: [tool] });
    const run = await runtime.start({ workspacePath: tmpdir(), goal: 'pause approval', agent: agentFor('test') });
    await waitFor(run.id, runtime, 'waiting_for_approval');
    const approvalEvent = (await store.listEvents(run.id)).find((event) => event.type === 'tool.approval_required');
    const approvalId = (approvalEvent?.payload as { approvalId: string }).approvalId;
    await runtime.command(run.id, { commandId: 'pause-approval', type: 'pause' });
    await expect(runtime.command(run.id, { commandId: 'approve-paused', type: 'approve', approvalId })).rejects.toThrow('Cannot approve');
    await expect(runtime.command(run.id, { commandId: 'reject-paused', type: 'reject', approvalId })).rejects.toThrow('Cannot reject');
    expect((await store.getApproval(approvalId)).decision).toBe('pending');
    await runtime.command(run.id, { commandId: 'resume-approval', type: 'resume' });
    await waitFor(run.id, runtime, 'waiting_for_approval');
    const approvalEvents = (await store.listEvents(run.id)).filter((event) => event.type === 'tool.approval_required');
    expect(approvalEvents).toHaveLength(1);
    await runtime.command(run.id, { commandId: 'approve-resumed', type: 'approve', approvalId });
    await waitFor(run.id, runtime, 'completed');
    expect(executions).toBe(1);
  });

  it('refuses to execute when the approved tool call arguments changed', async () => {
    const store = new MemoryRunStore();
    let providerCalls = 0;
    let executions = 0;
    const provider: ModelProvider = {
      capabilities: async () => ({ streaming: true, toolCalling: true, structuredOutput: false, vision: false }),
      async *stream() {
        providerCalls += 1;
        yield { type: 'tool_call', call: { id: 'provider-call', name: 'test.write', arguments: { content: 'original' } } };
      },
    };
    const tool: ToolDefinition<{ content: string }, string> = {
      name: 'test.write', version: '1', description: 'write', inputSchema: z.object({ content: z.string() }), jsonSchema: {},
      risk: 'write', capabilities: ['fs.write'], idempotency: 'unknown', execute: async (input) => { executions += 1; return input.content; },
    };
    const runtime = new DefaultAgentRuntime({ store, providers: { test: provider }, tools: [tool] });
    const run = await runtime.start({ workspacePath: tmpdir(), goal: 'tamper', agent: agentFor('test') });
    await waitFor(run.id, runtime, 'waiting_for_approval');
    const event = (await store.listEvents(run.id)).find((candidate) => candidate.type === 'tool.approval_required');
    const payload = event?.payload as { approvalId: string; toolCallId: string };
    const call = await store.getToolCall(payload.toolCallId);
    await store.upsertToolCall({ ...call, arguments: { content: 'tampered' } });
    await runtime.command(run.id, { commandId: 'approve-tampered', type: 'approve', approvalId: payload.approvalId });
    await waitFor(run.id, runtime, 'failed');
    expect(executions).toBe(0);
    expect((await runtime.get(run.id)).error?.message).toContain('no longer matches');
    expect(providerCalls).toBe(1);
  });

  it('replays tool results that arrive after cancellation', async () => {
    const store = new MemoryRunStore();
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const provider: ModelProvider = {
      capabilities: async () => ({ streaming: true, toolCalling: true, structuredOutput: false, vision: false }),
      async *stream() {
        yield { type: 'tool_call', call: { id: 'late-call', name: 'test.write', arguments: { content: 'late result' } } };
      },
    };
    const tool: ToolDefinition<{ content: string }, string> = {
      name: 'test.write', version: '1', description: 'write', inputSchema: z.object({ content: z.string() }), jsonSchema: {},
      risk: 'read', capabilities: ['fs.write'], idempotency: 'unknown',
      execute: async (input) => {
        markStarted();
        await new Promise<void>((resolve) => { release = resolve; });
        return input.content;
      },
    };
    const runtime = new DefaultAgentRuntime({ store, providers: { test: provider }, tools: [tool] });
    const run = await runtime.start({ workspacePath: tmpdir(), goal: 'late result', agent: agentFor('test') });
    await started;
    const startedEvent = (await store.listEvents(run.id)).find((event) => event.type === 'tool.started');
    const toolCallId = (startedEvent?.payload as { toolCallId: string }).toolCallId;
    await runtime.command(run.id, { commandId: 'cancel-late', type: 'cancel' });
    const received: RunEvent[] = [];
    const reading = (async () => {
      for await (const event of runtime.events(run.id)) {
        received.push(event);
        if (event.type === 'tool.completed') break;
      }
    })();
    release();
    await reading;
    await waitForTool(store, toolCallId, 'success');
    const types = received.map((event) => event.type);
    expect(types).toContain('run.cancelled');
    expect(types.indexOf('run.cancelled')).toBeLessThan(types.indexOf('tool.completed'));
    expect((await store.getToolCall(toolCallId)).result?.content).toEqual([{ type: 'text', text: 'late result' }]);
  });
});


describe('recovery event reconciliation', () => {
  it.each([
    { status: 'requested', eventType: 'tool.requested' },
    { status: 'waiting_for_approval', eventType: 'tool.approval_required' },
    { status: 'unknown', eventType: 'tool.started' },
  ] as const)('refuses automatic resume with a $status tool call', async ({ status, eventType }) => {
    const store = new MemoryRunStore();
    const runId = `unfinished-${status}`;
    const workspace = await store.createWorkspace(tmpdir());
    const session = await store.createSession(workspace.id, 'recovery');
    const now = new Date().toISOString();
    await store.createRun({
      id: runId, sessionId: session.id, workspaceId: workspace.id, rootRunId: runId,
      agentDefinitionId: 'coding-assistant', mode: 'single', permissionMode: 'ask', goal: 'recover', status: 'running', version: 0,
      budget: defaultAgent.spec.budget, usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, steps: 0 }, createdAt: now, updatedAt: now,
    });
    await store.upsertToolCall({ id: `${runId}-call`, runId, toolName: 'test.write', status, arguments: {}, createdAt: now, updatedAt: now });
    await store.commit(runId, 0, {}, [
      { type: 'run.started', actor: 'system', payload: { goal: 'recover', agent: agentFor('test') } },
      { type: eventType, actor: 'tool', payload: { toolCallId: `${runId}-call` } },
    ]);
    const runtime = new DefaultAgentRuntime({ store, providers: {}, tools: [] });
    await runtime.recoverInterrupted();
    await expect(runtime.command(runId, { commandId: `resume-${status}`, type: 'resume' })).rejects.toThrow('Cannot auto-resume');
    expect((await runtime.get(runId)).status).toBe('interrupted');
  });

  it('restores completed tool state and the full assistant/tool context', async () => {
    const store = new MemoryRunStore();
    const workspace = await store.createWorkspace(tmpdir());
    const session = await store.createSession(workspace.id, 'recovery');
    const now = new Date().toISOString();
    const agent = agentFor('test');
    const call = { id: 'completed-call', name: 'test.write', arguments: { content: 'persisted result' } };
    const result = { status: 'success' as const, content: [{ type: 'text' as const, text: 'persisted result' }], metadata: { durationMs: 1, truncated: false, retryable: false } };
    await store.createRun({
      id: 'completed-recovery', sessionId: session.id, workspaceId: workspace.id, rootRunId: 'completed-recovery',
      agentDefinitionId: 'coding-assistant', mode: 'single', permissionMode: 'ask', goal: 'recover', status: 'running', version: 0,
      budget: defaultAgent.spec.budget, usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, steps: 0 }, createdAt: now, updatedAt: now,
    });
    await store.upsertToolCall({ id: call.id, runId: 'completed-recovery', toolName: call.name, status: 'running', arguments: call.arguments, createdAt: now, updatedAt: now });
    await store.commit('completed-recovery', 0, {}, [
      { type: 'run.started', actor: 'system', payload: { goal: 'recover', agent } },
      { type: 'message.user', actor: 'user', payload: { content: 'recover' } },
      { type: 'message.assistant.completed', actor: 'agent', payload: { content: '', toolCalls: [call] } },
      { type: 'tool.started', actor: 'tool', payload: { toolCallId: call.id, name: call.name } },
      { type: 'tool.completed', actor: 'tool', payload: { toolCallId: call.id, name: call.name, result } },
    ]);
    let providerCalls = 0;
    let restoredRequest: Parameters<ModelProvider['stream']>[0] | undefined;
    const provider: ModelProvider = {
      capabilities: async () => ({ streaming: true, toolCalling: true, structuredOutput: false, vision: false }),
      async *stream(request) {
        providerCalls += 1;
        restoredRequest = request;
        yield { type: 'text_delta', text: 'recovered' };
        yield { type: 'done', reason: 'stop' };
      },
    };
    const runtime = new DefaultAgentRuntime({ store, providers: { test: provider }, tools: [] });
    await runtime.recoverInterrupted();
    expect((await store.getToolCall(call.id)).status).toBe('success');
    await runtime.command('completed-recovery', { commandId: 'resume-completed', type: 'resume' });
    await waitFor('completed-recovery', runtime, 'completed');
    expect(providerCalls).toBe(1);
    const assistant = restoredRequest?.messages.find((message) => message.role === 'assistant');
    const toolMessage = restoredRequest?.messages.find((message) => message.role === 'tool');
    expect(assistant?.toolCalls).toEqual([call]);
    expect(toolMessage).toMatchObject({ toolCallId: call.id, content: 'persisted result' });
  });

  it('refuses to resume a recovered queued run without run.started', async () => {
    const store = new MemoryRunStore();
    const workspace = await store.createWorkspace(tmpdir());
    const session = await store.createSession(workspace.id, 'recovery');
    const now = new Date().toISOString();
    await store.createRun({
      id: 'queued-recovery', sessionId: session.id, workspaceId: workspace.id, rootRunId: 'queued-recovery',
      agentDefinitionId: 'coding-assistant', mode: 'single', permissionMode: 'ask', goal: 'recover', status: 'queued', version: 0,
      budget: defaultAgent.spec.budget, usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, steps: 0 }, createdAt: now, updatedAt: now,
    });
    const runtime = new DefaultAgentRuntime({ store, providers: {}, tools: [] });
    await runtime.recoverInterrupted();
    await expect(runtime.command('queued-recovery', { commandId: 'resume-queued', type: 'resume' })).rejects.toThrow('without run.started');
    expect((await runtime.get('queued-recovery')).status).toBe('interrupted');
    expect((await store.listEvents('queued-recovery')).some((event) => event.type === 'run.resumed')).toBe(false);
  });
});
