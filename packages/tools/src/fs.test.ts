import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '@joymind/core';
import { createBuiltinTools, executeTool } from './index.js';

let workspacePath: string;
let context: ToolContext;

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'joymind-tools-'));
  context = { workspacePath, signal: new AbortController().signal };
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

async function call(name: string, args: unknown, overrides: Partial<ToolContext> = {}) {
  return executeTool(createBuiltinTools(), {
    id: 'call-1',
    runId: 'run-1',
    name,
    arguments: args,
  }, { ...context, ...overrides });
}

describe('fs.write', () => {
  it('requires approval without modifying the file', async () => {
    const result = await call('fs.write', { path: 'note.txt', content: 'approved text' });

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('approval_required');
    expect(result.metadata).toMatchObject({ truncated: false, retryable: false });
    await expect(readFile(join(workspacePath, 'note.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes an approved change and returns its diff', async () => {
    await writeFile(join(workspacePath, 'note.txt'), 'before\n');

    const result = await call('fs.write', { path: 'note.txt', content: 'after\n' }, { approved: true });

    expect(result.status).toBe('success');
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('-before');
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('+after');
    await expect(readFile(join(workspacePath, 'note.txt'), 'utf8')).resolves.toBe('after\n');
  });
});

describe('workspace file safety', () => {
  it.each(['../outside.txt', '/absolute/path', 'C:\\\\outside.txt'])('rejects escaping path %s', async (requestedPath) => {
    const result = await call('fs.read', { path: requestedPath });

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('permission_denied');
  });

  it('rejects a symlink that resolves outside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'joymind-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(outside, join(workspacePath, 'escape'), 'junction');

      const result = await call('fs.read', { path: 'escape/secret.txt' });

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('permission_denied');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not delete a file before approval', async () => {
    await writeFile(join(workspacePath, 'keep.txt'), 'keep');

    const result = await call('fs.delete', { path: 'keep.txt' });

    expect(result.error?.code).toBe('approval_required');
    await expect(readFile(join(workspacePath, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('limits file reads and reports truncation', async () => {
    await writeFile(join(workspacePath, 'large.txt'), 'x'.repeat(4096));

    const result = await call('fs.read', { path: 'large.txt', maxBytes: 128 });

    expect(result.status).toBe('success');
    expect(result.metadata.truncated).toBe(true);
    const output = JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '{}');
    expect(output.content).toHaveLength(128);
    expect(output.size).toBe(4096);
  });

  it('searches text with bounded results', async () => {
    await writeFile(join(workspacePath, 'a.txt'), 'needle one\nneedle two\n');

    const result = await call('fs.search', { query: 'needle', maxResults: 1 });

    expect(result.status).toBe('success');
    expect(result.metadata.truncated).toBe(true);
    const output = JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '{}');
    expect(output.matches).toEqual([{ path: 'a.txt', line: 1, text: 'needle one' }]);
  });

  it('previews a unified write diff without modifying the file', async () => {
    await writeFile(join(workspacePath, 'existing.txt'), 'before\n');
    const tool = createBuiltinTools().find((candidate) => candidate.name === 'fs.write');
    const previewWrite = tool?.preview?.bind(tool);
    expect(previewWrite).toBeDefined();
    const preview = await previewWrite?.({ path: 'existing.txt', content: 'after\n' }, context);
    expect(JSON.stringify(preview)).toContain('-before');
    expect(JSON.stringify(preview)).toContain('+after');
    await expect(readFile(join(workspacePath, 'existing.txt'), 'utf8')).resolves.toBe('before\n');
  });
});
