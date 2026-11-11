import type {
  NormalizedError,
  ToolCallRequest,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@joymind/core';
import { ToolError } from './errors.js';
import { createFileTools } from './fs.js';
import { createShellTool } from './shell.js';

function metadata(startedAt: number, truncated = false, retryable = false): ToolResult['metadata'] {
  return { durationMs: Date.now() - startedAt, truncated, retryable };
}

function errorResult(startedAt: number, error: NormalizedError, content: ToolResult['content'] = [], truncated = false): ToolResult {
  return {
    status: error.code === 'cancelled' ? 'cancelled' : 'error',
    content,
    error,
    metadata: metadata(startedAt, truncated, error.retryable),
  };
}

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof ToolError) {
    const normalized: NormalizedError = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
    if (error.details !== undefined) normalized.details = error.details;
    return normalized;
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.message === 'The operation was aborted')) {
    return { code: 'cancelled', message: 'Tool execution was cancelled', retryable: false };
  }
  return {
    code: 'tool_error',
    message: error instanceof Error ? error.message : 'Tool execution failed',
    retryable: false,
  };
}

function textContent(output: unknown): ToolResult['content'] {
  if (output === undefined) return [];
  return [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }];
}

export async function executeTool(
  definitions: ToolDefinition[],
  request: ToolCallRequest,
  context: ToolContext,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const definition = definitions.find((candidate) => candidate.name === request.name);
  if (definition === undefined) {
    return errorResult(startedAt, {
      code: 'tool_not_found',
      message: `Unknown tool: ${request.name}`,
      retryable: false,
      details: { tool: request.name },
    });
  }
  if (context.signal.aborted) {
    return errorResult(startedAt, { code: 'cancelled', message: 'Tool execution was cancelled', retryable: false });
  }

  const parsed = definition.inputSchema.safeParse(request.arguments);
  if (!parsed.success) {
    return errorResult(startedAt, {
      code: 'invalid_input',
      message: `Invalid input for ${request.name}`,
      retryable: false,
      details: { issues: parsed.error.issues },
    });
  }

  try {
    const output = await definition.execute(parsed.data, context);
    const truncated = typeof output === 'object' && output !== null && 'truncated' in output && output.truncated === true;
    return {
      status: 'success',
      content: textContent(output),
      metadata: metadata(startedAt, truncated),
    };
  } catch (error) {
    const normalized = normalizeError(error);
    return errorResult(
      startedAt,
      normalized,
      error instanceof ToolError ? error.content : [],
      error instanceof ToolError ? error.truncated : false,
    );
  }
}

export function createBuiltinTools(): ToolDefinition[] {
  return [...createFileTools(), createShellTool()];
}
