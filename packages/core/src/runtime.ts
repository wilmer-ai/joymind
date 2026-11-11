import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContextManager } from './context.js';
import { JoymindError, normalizeError } from './errors.js';
import { EventBus } from './event-bus.js';
import { extractPermissionAssessment } from './permissions.js';
import type { PermissionAssessment } from './permissions.js';
import { assertTransition, isTerminal } from './state-machine.js';
import { ToolRuntime } from './tool-runtime.js';
import type { RunStore } from './store.js';
import type {
  AgentRuntime, Approval, Budget, ModelMessage, ModelProvider, ModelToolCall, NewRunEvent,
  RunCommand, RunEvent, RunSnapshot, StartRunRequest, ToolDefinition, ToolResult,
} from './types.js';

interface ActiveRun {
  messages: ModelMessage[];
  abort: AbortController;
  approvedCalls: Set<string>;
  approvalByCall: Map<string, string>;
  permissionAssessments: Map<string, PermissionAssessment>;
  pendingCalls: ModelToolCall[];
  wake: () => void;
  waiting?: Promise<void> | undefined;
  executing: boolean;
}

interface RestoredRun {
  agent: StartRunRequest['agent'];
  messages: ModelMessage[];
}

export interface RuntimeOptions {
  store: RunStore;
  providers: Record<string, ModelProvider>;
  tools: ToolDefinition[];
}

export class DefaultAgentRuntime implements AgentRuntime {
  private readonly bus = new EventBus();
  private readonly active = new Map<string, ActiveRun>();
  private readonly contexts = new ContextManager();
  private readonly tools: ToolRuntime;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly commandLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: RuntimeOptions) {
    this.tools = new ToolRuntime(options.tools);
  }

  registerProvider(id: string, provider: ModelProvider): void {
    this.options.providers[id] = provider;
  }

  async start(request: StartRunRequest): Promise<RunSnapshot> {
    const agent = request.agent;
    if (!request.goal.trim()) throw new JoymindError({ code: 'configuration_error', message: 'Goal cannot be empty', retryable: false });
    const provider = this.options.providers[agent.spec.model.provider];
    if (!provider) throw new JoymindError({ code: 'configuration_error', message: `Unknown provider: ${agent.spec.model.provider}`, retryable: false });
    const workspace = request.workspaceId ? await this.options.store.getWorkspace(request.workspaceId) : await this.options.store.createWorkspace(resolve(request.workspacePath), basename(resolve(request.workspacePath)));
    const session = request.sessionId ? await this.options.store.getSession(request.sessionId) : await this.options.store.createSession(workspace.id, request.goal.slice(0, 80));
    const now = new Date().toISOString();
    const id = randomUUID();
    const run: RunSnapshot = {
      id, sessionId: session.id, workspaceId: workspace.id, rootRunId: request.parentRunId ?? id,
      ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
      agentDefinitionId: agent.metadata.id, mode: agent.spec.runtime.mode,
      permissionMode: agent.spec.permissions.mode, goal: request.goal,
      status: 'queued', version: 0, budget: agent.spec.budget,
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, steps: 0 }, createdAt: now, updatedAt: now,
    };
    await this.options.store.createRun(run);
    await this.commit(id, { status: 'running', startedAt: now }, [{ type: 'run.started', actor: 'system', payload: { goal: request.goal, agent } }, { type: 'message.user', actor: 'user', payload: { content: request.goal } }]);
    this.active.set(id, {
      messages: [{ role: 'system', content: agent.spec.prompt.template }, { role: 'user', content: request.goal }],
      abort: new AbortController(), approvedCalls: new Set(), approvalByCall: new Map(), permissionAssessments: new Map(), pendingCalls: [], wake: () => undefined, executing: false,
    });
    this.launch(id, agent);
    return this.get(id);
  }

  async get(runId: string): Promise<RunSnapshot> { return this.options.store.getRun(runId); }

  async listRuns(limit = 100): Promise<RunSnapshot[]> { return this.options.store.listRuns(limit); }
  async listSessions(workspaceId?: string) { return this.options.store.listSessions(workspaceId); }
  async listTools() { return this.tools.list().map(({ name, version, description, risk, jsonSchema }) => ({ name, version, description, risk, inputSchema: jsonSchema })); }

  async *events(runId: string, afterSeq = 0): AsyncIterable<RunEvent> {
    await this.get(runId);
    const queue: RunEvent[] = [];
    let notified: (() => void) | undefined;
    const unsubscribe = this.bus.subscribe(runId, (event) => { queue.push(event); notified?.(); });
    try {
      queue.push(...await this.options.store.listEvents(runId, afterSeq));
      queue.sort((a, b) => a.seq - b.seq);
      let last = afterSeq;
      while (true) {
        while (queue.length === 0) await new Promise<void>((resolveWake) => { notified = resolveWake; });
        notified = undefined;
        const event = queue.shift();
        if (event && event.seq > last) {
          last = event.seq;
          yield event;
        }
      }
    } finally {
      unsubscribe();
    }
  }

  async command(runId: string, command: RunCommand): Promise<RunSnapshot> {
    return this.serializeCommand(runId, async () => {
      if (await this.options.store.hasCommand(runId, command.commandId)) return this.get(runId);
      const run = await this.get(runId);
      const active = this.active.get(runId);
      switch (command.type) {
        case 'pause':
          if (!['running', 'waiting_for_approval', 'waiting_for_input'].includes(run.status)) throw new JoymindError({ code: 'conflict', message: `Cannot pause ${run.status}`, retryable: false });
          await this.commit(runId, { status: 'paused' }, [{ type: 'run.paused', actor: 'user', payload: {} }]);
          break;
        case 'resume': {
          if (!['paused', 'interrupted'].includes(run.status)) throw new JoymindError({ code: 'conflict', message: `Cannot resume ${run.status}`, retryable: false });
          const restored = run.status === 'interrupted' ? await this.prepareRestore(runId) : undefined;
          await this.commit(runId, { status: 'running' }, [{ type: 'run.resumed', actor: 'user', payload: {} }]);
          active?.wake();
          if (restored) this.restoreAndLaunch(runId, restored);
          else if (active && !active.executing) this.launchFromActive(runId);
          break;
        }
        case 'cancel':
          if (!isTerminal(run.status)) {
            active?.abort.abort();
            active?.wake();
            await this.commit(runId, { status: 'cancelled', finishedAt: new Date().toISOString(), finishReason: command.reason ?? 'Cancelled by user' }, [{ type: 'run.cancelled', actor: 'user', payload: { reason: command.reason } }]);
          }
          break;
        case 'approve': case 'reject': {
          if (run.status !== 'waiting_for_approval') throw new JoymindError({ code: 'conflict', message: `Cannot ${command.type} approval while run is ${run.status}`, retryable: false });
          const approval = await this.options.store.getApproval(command.approvalId);
          if (approval.runId !== runId || approval.decision !== 'pending') throw new JoymindError({ code: 'conflict', message: 'Approval is not pending for this run', retryable: false });
          const decision = command.type === 'approve' ? 'approved' : 'rejected';
          const reason = command.type === 'reject' ? command.reason : undefined;
          await this.options.store.updateApproval({ ...approval, decision, decidedAt: new Date().toISOString(), ...(reason ? { reason } : {}) });
          if (command.type === 'approve' && active) {
            active.approvalByCall.set(approval.toolCallId, approval.id);
            active.approvedCalls.add(approval.toolCallId);
          }
          if (command.type === 'reject' && active) {
            active.approvalByCall.delete(approval.toolCallId);
            active.pendingCalls = active.pendingCalls.filter((call) => call.id !== approval.toolCallId);
            active.messages.push({ role: 'tool', toolCallId: approval.toolCallId, content: `User rejected approval: ${command.reason ?? 'No reason supplied'}` });
          }
          await this.commit(runId, { status: 'running' }, [{ type: command.type === 'approve' ? 'approval.approved' : 'approval.rejected', actor: 'user', payload: { approvalId: approval.id, toolCallId: approval.toolCallId, reason } }]);
          active?.wake();
          if (active && !active.executing) this.launchFromActive(runId);
          break;
        }
        case 'answer':
          active?.messages.push({ role: 'user', content: command.answer });
          await this.commit(runId, { status: 'running' }, [{ type: 'message.user', actor: 'user', payload: { content: command.answer, requestId: command.requestId } }]);
          active?.wake();
          break;
      }
      await this.options.store.recordCommand(runId, command);
      return this.get(runId);
    });
  }

  async recoverInterrupted(): Promise<RunSnapshot[]> {
    const runs = await this.options.store.listRuns(Number.MAX_SAFE_INTEGER);
    const recovered: RunSnapshot[] = [];
    for (const run of runs.filter((candidate) => ['queued', 'running', 'waiting_for_approval', 'waiting_for_input', 'paused'].includes(candidate.status))) {
      const toolEvents = await this.options.store.listEvents(run.id);
      const finished = new Set(toolEvents.filter((event) => event.type === 'tool.completed' || event.type === 'tool.failed').map((event) => (event.payload as { toolCallId: string }).toolCallId));
      for (const event of toolEvents) {
        if (event.type !== 'tool.completed' && event.type !== 'tool.failed') continue;
        const payload = event.payload as { toolCallId: string; result: ToolResult };
        const call = await this.options.store.getToolCall(payload.toolCallId);
        await this.options.store.upsertToolCall({ ...call, status: event.type === 'tool.completed' ? 'success' : payload.result.status === 'cancelled' ? 'cancelled' : 'error', result: payload.result, updatedAt: new Date().toISOString() });
      }
      for (const event of toolEvents.filter((candidate) => candidate.type === 'tool.started')) {
        const payload = event.payload as { toolCallId: string };
        if (finished.has(payload.toolCallId)) continue;
        const call = await this.options.store.getToolCall(payload.toolCallId);
        if (call.status === 'running') await this.options.store.upsertToolCall({ ...call, status: 'unknown', updatedAt: new Date().toISOString() });
      }
      await this.commit(run.id, { status: 'interrupted', error: { code: 'interrupted', message: 'Runtime stopped before completion; verify side effects before resuming', retryable: false } }, [{ type: 'run.interrupted', actor: 'system', payload: {} }]);
      recovered.push(await this.get(run.id));
    }
    return recovered;
  }

  private async prepareRestore(runId: string): Promise<RestoredRun> {
    const events = await this.options.store.listEvents(runId);
    const started = events.find((event) => event.type === 'run.started');
    const agent = (started?.payload as { agent?: StartRunRequest['agent'] } | undefined)?.agent;
    if (!agent) throw new JoymindError({ code: 'conflict', message: 'Cannot resume a run without run.started; start a new run', retryable: false });
    const toolCallIds = new Set<string>();
    const finished = new Set<string>();
    for (const event of events) {
      if (!['tool.requested', 'tool.approval_required', 'tool.started', 'tool.completed', 'tool.failed'].includes(event.type)) continue;
      const toolCallId = (event.payload as { toolCallId: string }).toolCallId;
      toolCallIds.add(toolCallId);
      if (event.type === 'tool.completed' || event.type === 'tool.failed') finished.add(toolCallId);
    }
    for (const toolCallId of toolCallIds) {
      if (finished.has(toolCallId)) continue;
      const call = await this.options.store.getToolCall(toolCallId);
      if (!['success', 'error', 'cancelled'].includes(call.status)) {
        const reason = call.status === 'unknown' ? 'unknown tool side effects' : `unfinished tool call in ${call.status} state`;
        throw new JoymindError({ code: 'conflict', message: `Cannot auto-resume a run with ${reason}; start a new run after verification`, retryable: false });
      }
    }
    const messages: ModelMessage[] = [{ role: 'system', content: agent.spec.prompt.template }];
    for (const event of events) {
      if (event.type === 'message.user') messages.push({ role: 'user', content: (event.payload as { content: string }).content });
      if (event.type === 'message.assistant.completed') {
        const payload = event.payload as { content: string; toolCalls?: ModelToolCall[] };
        messages.push({ role: 'assistant', content: payload.content, ...(payload.toolCalls ? { toolCalls: payload.toolCalls } : {}) });
      }
      if (event.type === 'tool.completed' || event.type === 'tool.failed') {
        const payload = event.payload as { toolCallId: string; result: ToolResult };
        messages.push({ role: 'tool', toolCallId: payload.toolCallId, content: payload.result.content.map((item) => item.type === 'text' ? item.text : `[Artifact ${item.artifactId}]`).join('\n') });
      }
    }
    return { agent, messages };
  }

  private restoreAndLaunch(runId: string, restored: RestoredRun): void {
    this.active.set(runId, { messages: restored.messages, abort: new AbortController(), approvedCalls: new Set(), approvalByCall: new Map(), permissionAssessments: new Map(), pendingCalls: [], wake: () => undefined, executing: false });
    this.launch(runId, restored.agent);
  }

  private launchFromActive(runId: string): void {
    void this.options.store.listEvents(runId).then((events) => {
      const started = events.find((event) => event.type === 'run.started');
      const agent = (started?.payload as { agent: StartRunRequest['agent'] }).agent;
      const active = this.active.get(runId);
      if (active && !active.executing) this.launch(runId, agent);
    }).catch(() => undefined);
  }

  private launch(runId: string, agent: StartRunRequest['agent']): void {
    const active = this.active.get(runId);
    if (!active || active.executing) return;
    active.executing = true;
    void this.execute(runId, agent).catch(async (error) => {
      const run = await this.get(runId);
      if (!isTerminal(run.status) && run.status !== 'interrupted') {
        await this.commit(runId, { status: 'failed', finishedAt: new Date().toISOString(), finishReason: 'Execution failed', error: normalizeError(error) }, [{ type: 'run.failed', actor: 'system', payload: { error: normalizeError(error) } }]);
      }
    }).finally(() => {
      const current = this.active.get(runId);
      if (!current) return;
      current.executing = false;
      void this.get(runId).then((run) => {
        if (run.status === 'running' && this.active.get(runId) === current) this.launch(runId, agent);
      }).catch(() => undefined);
    });
  }

  private async execute(runId: string, agent: StartRunRequest['agent']): Promise<void> {
    const active = this.active.get(runId);
    if (!active) return;
    const provider = this.options.providers[agent.spec.model.provider];
    if (!provider) throw new JoymindError({ code: 'configuration_error', message: 'Provider unavailable', retryable: false });
    while (true) {
      const run = await this.get(runId);
      if (isTerminal(run.status) || run.status === 'interrupted' || run.status === 'waiting_for_approval') return;
      if (run.status === 'paused') { await this.wait(active); continue; }
      this.checkBudget(run);
      if (active.pendingCalls.length > 0) {
        if (await this.processPendingCalls(runId, agent)) return;
        continue;
      }
      const capabilities = await provider.capabilities(agent.spec.model.model);
      if (!capabilities.toolCalling) throw new JoymindError({ code: 'configuration_error', message: 'Selected model does not support tool calling', retryable: false });
      const descriptors = this.tools.list(agent.spec.tools.allow).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.jsonSchema }));
      const textParts: string[] = [];
      let usage = run.usage;
      for await (const event of provider.stream({ model: agent.spec.model.model, messages: this.contexts.build(active.messages, capabilities), tools: descriptors, signal: active.abort.signal })) {
        if (event.type === 'text_delta') { textParts.push(event.text); await this.commit(runId, {}, [{ type: 'message.assistant.delta', actor: 'agent', payload: { text: event.text } }]); }
        if (event.type === 'tool_call') {
          const id = randomUUID();
          const normalized = extractPermissionAssessment(event.call);
          active.pendingCalls.push({ ...normalized.call, id });
          if (normalized.assessment) active.permissionAssessments.set(id, normalized.assessment);
        }
        if (event.type === 'usage') usage = { ...usage, inputTokens: usage.inputTokens + event.inputTokens, outputTokens: usage.outputTokens + event.outputTokens };
      }
      const afterModel = await this.get(runId);
      if (isTerminal(afterModel.status) || afterModel.status === 'interrupted') return;
      if (afterModel.status === 'paused') {
        await this.wait(active);
        const afterPause = await this.get(runId);
        if (isTerminal(afterPause.status) || afterPause.status === 'interrupted') return;
      }
      const text = textParts.join('');
      const calls = [...active.pendingCalls];
      active.messages.push({ role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) });
      await this.commit(runId, { usage: { ...usage, steps: usage.steps + 1 } }, [{ type: 'message.assistant.completed', actor: 'agent', payload: { content: text, toolCalls: calls } }]);
      if (calls.length === 0) {
        await this.commit(runId, { status: 'completed', finishedAt: new Date().toISOString(), finishReason: 'Agent completed response' }, [{ type: 'run.completed', actor: 'system', payload: { content: text } }]);
        return;
      }
    }
  }

  private async processPendingCalls(runId: string, agent: StartRunRequest['agent']): Promise<boolean> {
    const active = this.active.get(runId);
    if (!active) return true;
    while (active.pendingCalls.length > 0) {
      const call = active.pendingCalls[0];
      if (!call) return false;
      let run = await this.get(runId);
      if (isTerminal(run.status) || run.status === 'interrupted') return true;
      if (run.status === 'paused') {
        await this.wait(active);
        run = await this.get(runId);
        if (isTerminal(run.status) || run.status === 'interrupted') return true;
      }
      const approvalId = active.approvalByCall.get(call.id);
      const approval = approvalId ? await this.options.store.getApproval(approvalId) : undefined;
      const approved = active.approvedCalls.delete(call.id);
      if (approved) {
        const approvedCall = await this.options.store.getToolCall(call.id);
        if (approval?.decision !== 'approved') throw new JoymindError({ code: 'conflict', message: 'Approval is no longer approved', retryable: false });
        if (approvedCall.runId !== runId || approvedCall.toolName !== call.name || !isDeepStrictEqual(approvedCall.arguments, call.arguments)) {
          throw new JoymindError({ code: 'conflict', message: 'Approved tool call no longer matches the pending call', retryable: false });
        }
      }
      if (!approved && approval) {
        if (approval.decision !== 'pending') throw new JoymindError({ code: 'conflict', message: 'Approval has already been consumed or rejected', retryable: false });
        if (run.status !== 'waiting_for_approval') await this.commit(runId, { status: 'waiting_for_approval' }, []);
        return true;
      }
      const now = new Date().toISOString();
      const permissionMode = agent.spec.permissions.mode;
      const assessment = active.permissionAssessments.get(call.id);
      const auditPermission = { permissionMode, ...(assessment ? { assessment } : {}) };
      if (!approved) {
        await this.options.store.upsertToolCall({ id: call.id, runId, toolName: call.name, status: 'requested', arguments: call.arguments, createdAt: now, updatedAt: now });
        await this.commit(runId, {}, [{ type: 'tool.requested', actor: 'agent', payload: { toolCallId: call.id, name: call.name, arguments: call.arguments, ...auditPermission } }]);
      }
      const definition = this.tools.get(call.name);
      const workspace = await this.options.store.getWorkspace(run.workspaceId);
      const requiresApproval = permissionMode === 'ask' || (permissionMode === 'auto' && assessment?.decision !== 'execute');
      if (definition.risk !== 'read' && !approved && requiresApproval) {
        const preview = definition.preview ? await definition.preview(definition.inputSchema.parse(call.arguments), { workspacePath: workspace.rootPath, signal: active.abort.signal }) : undefined;
        const diff = typeof preview === 'object' && preview !== null && 'diff' in preview && typeof preview.diff === 'string' ? preview.diff : undefined;
        const newApproval: Approval = { id: randomUUID(), runId, toolCallId: call.id, decision: 'pending', scope: `tool:${call.name}`, createdAt: now };
        await this.options.store.createApproval(newApproval);
        active.approvalByCall.set(call.id, newApproval.id);
        await this.options.store.upsertToolCall({ id: call.id, runId, toolName: call.name, status: 'waiting_for_approval', arguments: call.arguments, createdAt: now, updatedAt: now });
        await this.commit(runId, { status: 'waiting_for_approval' }, [{ type: 'tool.approval_required', actor: 'system', payload: { approvalId: newApproval.id, toolCallId: call.id, name: call.name, arguments: call.arguments, risk: definition.risk, ...auditPermission, ...(diff !== undefined ? { diff } : {}) } }]);
        return true;
      }
      await this.options.store.upsertToolCall({ id: call.id, runId, toolName: call.name, status: 'running', arguments: call.arguments, createdAt: now, updatedAt: now });
      await this.commit(runId, {}, [{ type: 'tool.started', actor: 'tool', payload: { toolCallId: call.id, name: call.name, ...auditPermission } }]);
      const result = await this.tools.execute({ ...call, runId }, { workspacePath: workspace.rootPath, signal: active.abort.signal, approved: true }, agent.spec.tools.allow);
      const usage = (await this.get(runId)).usage;
      await this.commit(runId, { usage: { ...usage, toolCalls: usage.toolCalls + 1 } }, [{ type: result.status === 'success' ? 'tool.completed' : 'tool.failed', actor: 'tool', payload: { toolCallId: call.id, name: call.name, result } }]);
      await this.options.store.upsertToolCall({ id: call.id, runId, toolName: call.name, status: result.status === 'success' ? 'success' : result.status, arguments: call.arguments, result, createdAt: now, updatedAt: new Date().toISOString() });
      active.approvalByCall.delete(call.id);
      active.permissionAssessments.delete(call.id);
      active.messages.push({ role: 'tool', toolCallId: call.id, content: result.content.map((item) => item.type === 'text' ? item.text : `[Artifact ${item.artifactId}]`).join('\n') });
      active.pendingCalls.shift();
    }
    return false;
  }

  private checkBudget(run: RunSnapshot): void {
    const budget: Budget = run.budget;
    const elapsed = (Date.now() - new Date(run.createdAt).getTime()) / 1000;
    if (run.usage.steps >= budget.maxSteps || run.usage.toolCalls >= budget.maxToolCalls || run.usage.inputTokens + run.usage.outputTokens >= budget.maxTokens || elapsed >= budget.maxWallTimeSeconds) {
      throw new JoymindError({ code: 'budget_exceeded', message: 'Run budget exhausted', retryable: false });
    }
  }

  private wait(active: ActiveRun): Promise<void> {
    if (!active.waiting) active.waiting = new Promise<void>((resolveWake) => { active.wake = () => { resolveWake(); active.waiting = undefined; }; });
    return active.waiting;
  }

  private async commit(runId: string, patch: Partial<RunSnapshot>, events: NewRunEvent[]): Promise<RunEvent[]> {
    return this.serialize(runId, async () => {
      const run = await this.options.store.getRun(runId);
      if (patch.status && patch.status !== run.status) assertTransition(run.status, patch.status);
      const committed = await this.options.store.commit(runId, run.version, { ...patch, updatedAt: new Date().toISOString() }, events);
      for (const event of committed) this.bus.publish(event);
      return committed;
    });
  }

  private async serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(runId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.locks.set(runId, result);
    try { return await result; } finally { if (this.locks.get(runId) === result) this.locks.delete(runId); }
  }

  private async serializeCommand<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.commandLocks.get(runId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.commandLocks.set(runId, result);
    try { return await result; } finally { if (this.commandLocks.get(runId) === result) this.commandLocks.delete(runId); }
  }
}
