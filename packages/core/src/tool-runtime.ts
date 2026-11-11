import { JoymindError, normalizeError } from './errors.js';
import type { ToolCallRequest, ToolContext, ToolDefinition, ToolResult } from './types.js';

export class ToolRuntime {
  constructor(private readonly definitions: ToolDefinition[]) {}

  list(allowed?: string[]): ToolDefinition[] {
    return allowed ? this.definitions.filter((tool) => allowed.includes(tool.name)) : [...this.definitions];
  }

  get(name: string): ToolDefinition {
    const tool = this.definitions.find((candidate) => candidate.name === name);
    if (!tool) throw new JoymindError({ code: 'configuration_error', message: `Unknown tool: ${name}`, retryable: false });
    return tool;
  }

  async execute(request: ToolCallRequest, context: ToolContext, allowed: string[]): Promise<ToolResult> {
    const started = Date.now();
    try {
      if (!allowed.includes(request.name)) {
        throw new JoymindError({ code: 'permission_denied', message: `Tool ${request.name} is not allowed for this agent`, retryable: false });
      }
      const tool = this.get(request.name);
      if (tool.risk !== 'read' && !context.approved) {
        throw new JoymindError({ code: 'approval_required', message: `Approval required for ${request.name}`, retryable: false });
      }
      const input = tool.inputSchema.parse(request.arguments);
      const output = await tool.execute(input, context);
      if (tool.outputSchema) tool.outputSchema.parse(output);
      return { status: 'success', content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }], metadata: { durationMs: Date.now() - started, truncated: false, retryable: false } };
    } catch (error) {
      const normalized = normalizeError(error, 'tool_error');
      return {
        status: normalized.code === 'cancelled' ? 'cancelled' : 'error',
        content: [{ type: 'text', text: normalized.message }],
        error: normalized,
        metadata: { durationMs: Date.now() - started, truncated: false, retryable: normalized.retryable },
      };
    }
  }
}
