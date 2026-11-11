import type { ToolResult } from '@joymind/core';

export class ToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly content: ToolResult['content'];
  readonly truncated: boolean;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      details?: Record<string, unknown>;
      content?: ToolResult['content'];
      truncated?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ToolError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.content = options.content ?? [];
    this.truncated = options.truncated ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function approvalRequired(toolName: string): ToolError {
  return new ToolError('approval_required', `${toolName} requires approval for this call`, {
    details: { tool: toolName },
  });
}
