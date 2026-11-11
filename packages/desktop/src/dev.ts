import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');
const appRoot = resolve(desktopRoot, '..', 'app');
const repositoryRoot = resolve(desktopRoot, '..', '..');
const serverUrl = 'http://127.0.0.1:5173';
const require = createRequire(import.meta.url);
const children = new Set<ChildProcess>();
let stopping = false;

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: 'inherit', shell: false });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}

async function exited(child: ChildProcess): Promise<number> {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(serverUrl, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Vite is still starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('Vite 开发服务器启动超时。');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const vite = run(process.execPath, [join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], appRoot);
try {
  await waitForServer();
  const typecheck = run(process.execPath, [join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(desktopRoot, 'tsconfig.json')], desktopRoot);
  if (await exited(typecheck) !== 0) throw new Error('Desktop TypeScript 构建失败。');
  const electronPath = require('electron') as string;
  const electron = run(electronPath, [desktopRoot], desktopRoot, { ...process.env, JOYMIND_DEV_SERVER_URL: serverUrl });
  process.exitCode = await exited(electron);
} finally {
  stop();
  if (!vite.killed) vite.kill();
}
