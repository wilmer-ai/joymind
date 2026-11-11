import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '@joymind/core';
import { createBuiltinTools, executeTool } from './index.js';

const context: ToolContext = {
  workspacePath: '.',
  signal: new AbortController().signal,
};

function request(name: string, args: unknown) {
  return { id: 'call-1', runId: 'run-1', name, arguments: args };
}

describe('builtin tool contract', () => {
  it('exposes all tools with model schemas and risk levels', () => {
    const tools = createBuiltinTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'fs.read', 'fs.list', 'fs.search', 'fs.write', 'fs.delete', 'shell.exec',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema).toBeInstanceOf(z.ZodType);
      expect(tool.jsonSchema).toMatchObject({ type: 'object' });
      expect(tool.description.length).toBeGreaterThan(0);
      expect(['read', 'write', 'execute']).toContain(tool.risk);
    }
    expect(tools.find((tool) => tool.name === 'fs.write')?.risk).toBe('write');
    expect(tools.find((tool) => tool.name === 'shell.exec')?.risk).toBe('execute');
  });

  it('normalizes schema errors with standard metadata', async () => {
    const result = await executeTool(createBuiltinTools(), request('fs.read', {}), context);

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_input');
    expect(result.metadata).toEqual({
      durationMs: expect.any(Number), truncated: false, retryable: false,
    });
  });

  it('does not invoke a tool for an already-cancelled call', async () => {
    const controller = new AbortController();
    controller.abort();
    let executed = false;
    const result = await executeTool([{
      name: 'test.tool', version: '1', description: 'test',
      inputSchema: z.object({}), jsonSchema: { type: 'object' }, risk: 'read',
      capabilities: [], idempotency: 'safe',
      execute: async () => {
        executed = true;
        return 'done';
      },
    }], request('test.tool', {}), { ...context, signal: controller.signal });

    expect(result.status).toBe('cancelled');
    expect(executed).toBe(false);
  });
});
