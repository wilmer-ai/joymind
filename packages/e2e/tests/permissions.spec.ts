import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('autonomous and agent-assessed auto modes execute workspace writes without approval prompts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'joymind-permissions-e2e-'));
  const workspace = join(directory, 'workspace');
  const userData = join(directory, 'user-data');
  const script = join(directory, 'script.json');
  await mkdir(workspace);
  await mkdir(userData);
  await writeFile(join(userData, 'preferences.json'), JSON.stringify({
    version: 1, locale: 'en-US', workspacePath: workspace, provider: 'scripted', models: {}, baseUrls: {},
  }));
  await writeFile(script, JSON.stringify([
    [{ type: 'tool_call', call: { id: 'autonomous-write', name: 'fs.write', arguments: { path: 'autonomous.txt', content: 'autonomous' } } }],
    [{ type: 'text_delta', text: 'Autonomous write complete' }, { type: 'done', reason: 'stop' }],
    [{ type: 'tool_call', call: { id: 'auto-write', name: 'fs.write', arguments: {
      path: 'auto.txt', content: 'auto',
      __joymind_permission: { decision: 'execute', reason: 'The user explicitly requested this workspace file' },
    } } }],
    [{ type: 'text_delta', text: 'Auto write complete' }, { type: 'done', reason: 'stop' }],
  ]));
  const executablePath = process.env.JOYMIND_EXECUTABLE;
  const application = await electron.launch(executablePath
    ? { executablePath, args: [], env: { ...process.env, JOYMIND_SCRIPT: script, JOYMIND_USER_DATA: userData, JOYMIND_DB: join(directory, 'joymind.db') } }
    : { args: [resolve('../../packages/desktop')], env: { ...process.env, JOYMIND_SCRIPT: script, JOYMIND_USER_DATA: userData, JOYMIND_DB: join(directory, 'joymind.db') } });
  try {
    const window = await application.firstWindow();
    await expect(window.getByText('New task', { exact: true })).toBeVisible();
    await window.getByLabel('Permission mode', { exact: true }).selectOption('autonomous');
    await window.getByLabel('Goal', { exact: true }).fill('Write autonomous.txt');
    await window.getByRole('button', { name: 'Start task' }).click();
    await expect(window.getByText('Completed', { exact: true }).first()).toBeVisible();
    expect(await readFile(join(workspace, 'autonomous.txt'), 'utf8')).toBe('autonomous');
    expect(await window.getByText('Approval required', { exact: true }).count()).toBe(0);
    await expect(window.locator('.permission-autonomous')).toHaveText('Autonomous');

    await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.items[0]?.submenu?.items.find((candidate) => candidate.label === 'New Task');
      if (!item) throw new Error('New Task menu item is missing');
      (item.click as unknown as () => void)();
    });
    await expect(window.getByLabel('Goal', { exact: true })).toBeFocused();
    await window.getByLabel('Permission mode', { exact: true }).selectOption('auto');
    await window.getByLabel('Goal', { exact: true }).fill('Write auto.txt');
    await window.getByRole('button', { name: 'Start task' }).click();
    await expect(window.getByText('Auto write complete', { exact: true })).toBeVisible();
    await expect(window.locator('.permission-auto')).toHaveText('Automatic');
    expect(await readFile(join(workspace, 'auto.txt'), 'utf8')).toBe('auto');
    expect(await window.getByText('Approval required', { exact: true }).count()).toBe(0);
    await expect(window.locator('.permission-auto')).toHaveText('Automatic');
  } finally {
    await application.close();
  }
});
