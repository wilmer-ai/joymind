import { z } from 'zod';

export const runStatuses = ['queued', 'running', 'waiting_for_approval', 'waiting_for_input', 'paused', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export type RunStatus = (typeof runStatuses)[number];
export type RunMode = 'single' | 'supervisor' | 'subagent';
export const permissionModeSchema = z.enum(['ask', 'auto', 'autonomous']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export type ToolRisk = 'read' | 'write' | 'execute' | 'network' | 'external';
export type ToolCallStatus = 'requested' | 'waiting_for_approval' | 'running' | 'success' | 'error' | 'cancelled' | 'unknown';

export interface Workspace { id: string; name: string; rootPath: string; createdAt: string; lastOpenedAt: string }
export interface Session { id: string; workspaceId: string; title: string; createdAt: string; updatedAt: string }

export const budgetSchema = z.object({
  maxSteps: z.number().int().positive().max(1000).default(40),
  maxToolCalls: z.number().int().positive().max(1000).default(60),
  maxTokens: z.number().int().positive().max(10_000_000).default(200_000),
  maxWallTimeSeconds: z.number().int().positive().max(86_400).default(1800),
  maxNoProgressSteps: z.number().int().positive().max(100).default(8),
}).strict();
export type Budget = z.infer<typeof budgetSchema>;

export interface Usage { inputTokens: number; outputTokens: number; estimatedCostUsd?: number; toolCalls: number; steps: number }

export interface RunSnapshot {
  id: string;
  sessionId: string;
  workspaceId: string;
  parentRunId?: string;
  rootRunId: string;
  agentDefinitionId: string;
  mode: RunMode;
  permissionMode: PermissionMode;
  goal: string;
  status: RunStatus;
  version: number;
  budget: Budget;
  usage: Usage;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  finishReason?: string;
  error?: NormalizedError;
}

export interface RunEvent<T = unknown> {
  id: string;
  runId: string;
  seq: number;
  type: string;
  occurredAt: string;
  actor: 'user' | 'agent' | 'tool' | 'system';
  payload: T;
  correlationId?: string;
  causationId?: string;
}

export interface NewRunEvent {
  type: string;
  actor: RunEvent['actor'];
  payload: unknown;
  correlationId?: string;
  causationId?: string;
}

export interface NormalizedError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  causeRef?: string;
}

export const agentDefinitionSchema = z.object({
  apiVersion: z.literal('joymind.dev/v1alpha1'),
  kind: z.literal('AgentDefinition'),
  metadata: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9.-]+$/), version: z.string(), name: z.string() }).strict(),
  spec: z.object({
    model: z.object({ provider: z.string(), model: z.string() }).strict(),
    prompt: z.object({ template: z.string() }).strict(),
    tools: z.object({ allow: z.array(z.string()).min(1) }).strict(),
    permissions: z.object({ mode: permissionModeSchema.default('ask') }).strict().prefault({}),
    budget: budgetSchema.prefault({}),
    runtime: z.object({ mode: z.enum(['single', 'supervisor', 'subagent']).default('single') }).strict(),
  }).strict(),
}).strict();
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export type RunCommand = { commandId: string } & (
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel'; reason?: string }
  | { type: 'approve'; approvalId: string }
  | { type: 'reject'; approvalId: string; reason?: string }
  | { type: 'answer'; requestId: string; answer: string }
);

export interface StartRunRequest {
  workspacePath: string;
  workspaceId?: string;
  sessionId?: string;
  goal: string;
  agent: AgentDefinition;
  parentRunId?: string;
  taskId?: string;
}

export interface AgentRuntime {
  start(request: StartRunRequest): Promise<RunSnapshot>;
  command(runId: string, command: RunCommand): Promise<RunSnapshot>;
  get(runId: string): Promise<RunSnapshot>;
  events(runId: string, afterSeq?: number): AsyncIterable<RunEvent>;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
}
export interface ModelToolCall { id: string; name: string; arguments: unknown }
export interface ModelToolDescriptor { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools: ModelToolDescriptor[];
  maxOutputTokens?: number;
  signal: AbortSignal;
}
export interface ModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  vision: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}
export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: ModelToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; reason: string };
export interface ModelProvider {
  capabilities(model: string): Promise<ModelCapabilities>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export interface ToolCallRequest { id: string; runId: string; name: string; arguments: unknown }
export interface ToolContext {
  workspacePath: string;
  signal: AbortSignal;
  approved?: boolean;
  onOutput?: (text: string) => void;
}
export interface ToolResult {
  status: 'success' | 'error' | 'cancelled' | 'unknown';
  content: Array<{ type: 'text'; text: string } | { type: 'artifact'; artifactId: string }>;
  error?: NormalizedError;
  metadata: { durationMs: number; truncated: boolean; retryable: boolean };
}
export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  version: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema?: z.ZodType<O>;
  jsonSchema: Record<string, unknown>;
  risk: ToolRisk;
  capabilities: string[];
  idempotency: 'safe' | 'idempotent' | 'unknown';
  preview?(input: I, context: ToolContext): Promise<unknown>;
  execute(input: I, context: ToolContext): Promise<O>;
}

export interface Artifact { id: string; runId: string; kind: string; path: string; mime: string; size: number; checksum: string; createdAt: string }
export interface Approval { id: string; runId: string; toolCallId: string; decision: 'pending' | 'approved' | 'rejected'; scope: string; createdAt: string; decidedAt?: string; reason?: string }
export interface ToolCallRecord { id: string; runId: string; toolName: string; status: ToolCallStatus; arguments: unknown; result?: ToolResult; createdAt: string; updatedAt: string }
