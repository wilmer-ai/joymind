import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext, ToolResult } from '@joymind/core';
import { createBuiltinTools, executeTool } from './index.js';

let workspacePath: string;
let signal: AbortSignal;

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'joymind-shell-'));
  signal = new AbortController().signal;
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

function nodeCommand(script: string): string {
  return `"${process.execPath}" -e "${script}"`;
}

async function call(command: string, options: {
  approved?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
} = {}): Promise<ToolResult> {
  const context: ToolContext = {
    workspacePath,
    signal: options.signal ?? signal,
    approved: options.approved ?? true,
  };
  return executeTool(createBuiltinTools(), {
    id: 'shell-call', runId: 'run-1', name: 'shell.exec',
    arguments: {
      command,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    },
  }, context);
}

function output(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '{}');
}

describe('shell.exec', () => {
  it('does not execute an unapproved command', async () => {
    const result = await call(nodeCommand("require('fs').writeFileSync('created.txt', 'no')"), { approved: false });

    expect(result.error?.code).toBe('approval_required');
    await expect(readFile(join(workspacePath, 'created.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('captures stdout and stderr from a successful command', async () => {
    const result = await call(nodeCommand("console.log('out'); console.error('err')"));

    expect(result.status).toBe('success');
    expect(output(result)).toMatchObject({ exitCode: 0, stdout: 'out\n', stderr: 'err\n' });
  });

  it('returns output and the exit code from a failed command', async () => {
    const result = await call(nodeCommand("console.error('bad'); process.exit(7)"));

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('tool_error');
    expect(result.error?.details).toMatchObject({ exitCode: 7 });
    expect(output(result)).toMatchObject({ exitCode: 7, stderr: 'bad\n' });
  });

  it('bounds long output and marks it truncated', async () => {
    const result = await call(nodeCommand("process.stdout.write('x'.repeat(200000))"), { maxOutputBytes: 1024 });

    expect(result.status).toBe('success');
    expect(result.metadata.truncated).toBe(true);
    expect(output(result).stdout).toHaveLength(1024);
  });

  it('times out and terminates a command', async () => {
    const result = await call(nodeCommand('setTimeout(() => {}, 10000)'), { timeoutMs: 100 });

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expect(result.metadata.retryable).toBe(true);
  });

  it('cancels a running command through AbortSignal', async () => {
    const controller = new AbortController();
    const pending = call(nodeCommand('setTimeout(() => {}, 10000)'), { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);

    const result = await pending;

    expect(result.status).toBe('cancelled');
    expect(result.error?.code).toBe('cancelled');
  });

  it('terminates descendants when cancelled', async () => {
    const controller = new AbortController();
    const parentScript = "const {spawn}=require('child_process'); spawn(process.execPath,['-e','setTimeout(()=>require(\\'fs\\').writeFileSync(\\'child.txt\\',\\'ran\\'),500)'],{stdio:'ignore'}); setTimeout(()=>{},10000)";
    const pending = call(nodeCommand(parentScript), { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);

    const result = await pending;
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(result.status).toBe('cancelled');
    await expect(readFile(join(workspacePath, 'child.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not inherit unlisted environment variables', async () => {
    process.env.JOYMIND_TEST_SECRET = 'do-not-pass';
    try {
      const result = await call(nodeCommand("console.log(process.env.JOYMIND_TEST_SECRET ?? 'missing')"));

      expect(result.status).toBe('success');
      expect(output(result).stdout).toBe('missing\n');
    } finally {
      delete process.env.JOYMIND_TEST_SECRET;
    }
  });
});
