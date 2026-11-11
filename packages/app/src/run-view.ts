import type { RunEvent, ToolResult } from '@joymind/core';

export interface MessageView {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  completed: boolean;
  seq: number;
}

export interface ToolView {
  id: string;
  name: string;
  arguments: unknown;
  status: string;
  risk?: string;
  firstSeq: number;
  startedAt?: string;
  updatedAt: string;
  result?: ToolResult;
}

export interface ApprovalView {
  id: string;
  toolCallId: string;
  name: string;
  arguments: unknown;
  risk: string;
  decision: 'pending' | 'approved' | 'rejected';
  reason?: string;
  diff?: string;
  createdAt: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function deriveRunView(events: RunEvent[]): {
  messages: MessageView[];
  tools: ToolView[];
  approvals: ApprovalView[];
} {
  const messages: MessageView[] = [];
  const tools = new Map<string, ToolView>();
  const approvals = new Map<string, ApprovalView>();
  let draft: MessageView | undefined;

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const payload = record(event.payload);
    if (event.type === 'message.user') {
      messages.push({ id: event.id, role: 'user', content: text(payload.content), completed: true, seq: event.seq });
      draft = undefined;
    } else if (event.type === 'message.assistant.delta') {
      if (!draft) {
        draft = { id: `assistant-${event.runId}-${event.seq}`, role: 'assistant', content: '', completed: false, seq: event.seq };
        messages.push(draft);
      }
      draft.content += text(payload.text);
    } else if (event.type === 'message.assistant.completed') {
      if (draft) {
        draft.content = text(payload.content);
        draft.completed = true;
      } else {
        messages.push({ id: event.id, role: 'assistant', content: text(payload.content), completed: true, seq: event.seq });
      }
      draft = undefined;
    }

    if (event.type.startsWith('tool.')) {
      const toolCallId = text(payload.toolCallId);
      if (toolCallId) {
        const previous = tools.get(toolCallId);
        const tool: ToolView = previous ?? {
          id: toolCallId,
          name: text(payload.name),
          arguments: payload.arguments,
          status: 'requested',
          firstSeq: event.seq,
          updatedAt: event.occurredAt,
        };
        tool.name = text(payload.name) || tool.name;
        if (payload.arguments !== undefined) tool.arguments = payload.arguments;
        tool.updatedAt = event.occurredAt;
        if (event.type === 'tool.approval_required') {
          tool.status = 'waiting_for_approval';
          const risk = text(payload.risk);
          if (risk) tool.risk = risk;
        } else if (event.type === 'tool.started') {
          tool.status = 'running';
          tool.startedAt = event.occurredAt;
        } else if (event.type === 'tool.completed') {
          tool.status = 'success';
          tool.result = payload.result as ToolResult;
        } else if (event.type === 'tool.failed') {
          tool.result = payload.result as ToolResult;
          tool.status = tool.result?.status ?? 'error';
        }
        tools.set(toolCallId, tool);
      }
    }

    if (event.type === 'tool.approval_required') {
      const id = text(payload.approvalId);
      if (id) {
        approvals.set(id, {
          id,
          toolCallId: text(payload.toolCallId),
          name: text(payload.name),
          arguments: payload.arguments,
          risk: text(payload.risk),
          decision: 'pending',
          ...(typeof payload.diff === 'string' ? { diff: payload.diff } : {}),
          createdAt: event.occurredAt,
        });
      }
    } else if (event.type === 'approval.approved' || event.type === 'approval.rejected') {
      const id = text(payload.approvalId);
      const approval = approvals.get(id);
      if (approval) {
        approval.decision = event.type === 'approval.approved' ? 'approved' : 'rejected';
        if (typeof payload.reason === 'string') approval.reason = payload.reason;
      }
    }
  }

  return {
    messages,
    tools: [...tools.values()].sort((left, right) => left.firstSeq - right.firstSeq),
    approvals: [...approvals.values()],
  };
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function toolOutput(result: ToolResult | undefined): string {
  if (!result) return '';
  return result.content.map((item) => item.type === 'text' ? item.text : `[Artifact ${item.artifactId}]`).join('\n');
}

export function writeDiff(result: ToolResult | undefined): string | undefined {
  const output = toolOutput(result);
  if (!output) return undefined;
  try {
    const parsed: unknown = JSON.parse(output);
    const diff = record(parsed).diff;
    return typeof diff === 'string' ? diff : undefined;
  } catch {
    return undefined;
  }
}
