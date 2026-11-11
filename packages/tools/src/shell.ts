import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '@joymind/core';
import { approvalRequired, ToolError } from './errors.js';
import { resolveWorkspacePath } from './paths.js';

const shellInput = z.object({
  command: z.string().min(1).max(10_000),
  cwd: z.string().min(1).default('.'),
  timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  maxOutputBytes: z.number().int().min(1).max(1024 * 1024).default(64 * 1024),
}).strict();
const shellOutput = z.object({
  cwd: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  truncated: z.boolean(),
});

type ShellInput = z.infer<typeof shellInput>;
type ShellOutput = z.infer<typeof shellOutput>;

function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const pathValue = process.env.PATH ?? process.env.Path ?? process.env.path;
  if (pathValue !== undefined) env.PATH = pathValue;
  const allowed = process.platform === 'win32'
    ? ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']
    : ['TMPDIR', 'TEMP', 'TMP'];
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function shellCommand(command: string): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    return { executable: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`] };
  }
  return { executable: '/bin/sh', args: ['-c', command] };
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    await new Promise<void>((resolve) => {
      const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
        env: minimalEnvironment(),
      });
      taskkill.once('error', () => {
        child.kill();
        resolve();
      });
      taskkill.once('close', () => resolve());
    });
    return;
  }
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall back to the direct child if the process group has already exited.
    }
  }
  child.kill('SIGKILL');
}

function resultContent(output: ShellOutput): ToolResult['content'] {
  return [{ type: 'text', text: JSON.stringify(output, null, 2) }];
}

async function executeShell(input: ShellInput, context: ToolContext): Promise<ShellOutput> {
  if (context.approved !== true) throw approvalRequired('shell.exec');
  if (context.signal.aborted) throw new ToolError('cancelled', 'Command was cancelled before it started');
  const cwd = await resolveWorkspacePath(context.workspacePath, input.cwd, { allowWorkspaceRoot: true });
  const invocation = shellCommand(input.command);

  return new Promise<ShellOutput>((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: minimalEnvironment(),
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const allowed = Math.max(0, input.maxOutputBytes - capturedBytes);
      const kept = chunk.subarray(0, allowed);
      capturedBytes += kept.length;
      if (kept.length < chunk.length) truncated = true;
      if (kept.length > 0) {
        (stream === 'stdout' ? stdout : stderr).push(kept);
        context.onOutput?.(kept.toString('utf8'));
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => {
      cancelled = true;
      void terminateProcessTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child);
    }, input.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk));
    context.signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (exitCode, exitSignal) => {
      const output: ShellOutput = {
        cwd: input.cwd,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        signal: exitSignal,
        truncated,
      };
      if (cancelled) {
        finish(() => reject(new ToolError('cancelled', 'Command was cancelled', {
          content: resultContent(output), truncated,
        })));
      } else if (timedOut) {
        finish(() => reject(new ToolError('timeout', `Command exceeded ${input.timeoutMs} ms`, {
          retryable: true,
          details: { timeoutMs: input.timeoutMs },
          content: resultContent(output), truncated,
        })));
      } else if (exitCode !== 0) {
        finish(() => reject(new ToolError('tool_error', exitCode === null ? `Command terminated by ${exitSignal ?? 'a signal'}` : `Command exited with code ${exitCode}`, {
          details: { exitCode, signal: exitSignal },
          content: resultContent(output), truncated,
        })));
      } else {
        finish(() => resolve(output));
      }
    });
  });
}

export function createShellTool(): ToolDefinition {
  return {
    name: 'shell.exec',
    version: '0.1.0',
    description: 'Execute one shell command in the workspace after approval, with a minimal environment and bounded output.',
    inputSchema: shellInput,
    outputSchema: shellOutput,
    jsonSchema: z.toJSONSchema(shellInput, { target: 'draft-07' }),
    risk: 'execute',
    capabilities: ['process:execute'],
    idempotency: 'unknown',
    execute: executeShell,
  };
}
