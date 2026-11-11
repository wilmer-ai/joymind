import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const cli = resolve('../../packages/cli/dist/index.js');

async function execute(args: string[], env: NodeJS.ProcessEnv = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NO_COLOR;
  delete childEnv.FORCE_COLOR;
  const child = spawn(process.execPath, [cli, ...args], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number>((resolveExit) => child.once('exit', (value) => resolveExit(value ?? 1)));
  return { code, stdout, stderr };
}

test('CLI blocks unapproved writes and executes an approved real workspace task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'joymind-e2e-'));
  const workspace = join(directory, 'workspace');
  const db = join(directory, 'joymind.db');
  const script = join(directory, 'script.json');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
  await writeFile(script, JSON.stringify([
    [{ type: 'tool_call', call: { id: 'write-1', name: 'fs.write', arguments: { path: 'result.txt', content: 'Joymind E2E passed' } } }],
    [{ type: 'text_delta', text: 'File created' }, { type: 'done', reason: 'stop' }],
  ]));
  const env = { JOYMIND_SCRIPT: script };
  const denied = await execute(['run', 'write result', '--workspace', workspace, '--db', db, '--json'], env);
  expect(denied.code, `${denied.stdout}\n${denied.stderr}`).toBe(5);
  await expect(readFile(join(workspace, 'result.txt'), 'utf8')).rejects.toThrow();

  const approved = await execute(['run', 'write result', '--workspace', workspace, '--db', db, '--approve', '--json'], env);
  expect(approved.stderr).toBe('');
  expect(approved.code).toBe(0);
  expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('Joymind E2E passed');
  const events = approved.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string });
  expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(1);

  const history = await execute(['runs', 'list', '--db', db, '--json']);
  expect(history.code).toBe(0);
  const runs = JSON.parse(history.stdout) as Array<{ status: string }>;
  expect(runs).toHaveLength(2);
  expect(runs.some((run) => run.status === 'completed')).toBe(true);
});

test('CLI exposes the extended provider catalog and English runtime output', async () => {
  const listed = await execute(['providers', 'list', '--db', ':memory:', '--json']);
  expect(listed.code, listed.stderr).toBe(0);
  const catalog = JSON.parse(listed.stdout) as Array<{ id: string; models: string[] }>;
  expect(catalog.map((provider) => provider.id)).toEqual(expect.arrayContaining(['openai', 'deepseek', 'anthropic', 'gemini', 'moonshot', 'qwen', 'zhipu', 'openai-compatible']));
  expect(catalog.find((provider) => provider.id === 'deepseek')?.models).toEqual(['deepseek-flash', 'deepseek-v4-pro']);

  const run = await execute(['run', 'offline smoke', '--workspace', '.', '--db', ':memory:', '--locale', 'en-US']);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain('completed:');
  expect(run.stderr).toBe('');
});
