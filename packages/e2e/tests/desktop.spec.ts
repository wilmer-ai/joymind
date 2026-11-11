import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('Electron runs a real approved workspace write without exposing Node to the renderer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'joymind-desktop-e2e-'));
  const workspace = join(directory, 'workspace');
  const userData = join(directory, 'user-data');
  const script = join(directory, 'script.json');
  await mkdir(workspace);
  await mkdir(userData);
  await writeFile(join(userData, 'preferences.json'), JSON.stringify({ version: 1, locale: 'zh-CN', workspacePath: workspace, provider: 'scripted', models: {}, baseUrls: {} }));
  await writeFile(script, JSON.stringify([
    [{ type: 'tool_call', call: { id: 'desktop-write', name: 'fs.write', arguments: { path: 'desktop.txt', content: 'Desktop E2E passed' } } }],
    [{ type: 'text_delta', text: '## 执行结果\n\n**桌面任务已完成**\n\n- 文件已写入\n\n`desktop.txt`\n\n<img src="x" onerror="window.__joymindXss=true"><script>window.__joymindXss=true</script>' }, { type: 'done', reason: 'stop' }],
  ]));
  const env = { ...process.env, JOYMIND_SCRIPT: script, JOYMIND_USER_DATA: userData, JOYMIND_DB: join(directory, 'joymind.db') };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const executablePath = process.env.JOYMIND_EXECUTABLE;
  const application = await electron.launch(executablePath
    ? { executablePath, args: [], env }
    : { args: [resolve('../../packages/desktop')], env });
  application.process().stdout.on('data', (chunk: Buffer) => console.log(`[electron stdout] ${chunk.toString()}`));
  application.process().stderr.on('data', (chunk: Buffer) => console.log(`[electron stderr] ${chunk.toString()}`));
  try {
    const window = await application.firstWindow();
    await expect(window.getByRole('heading', { name: 'Joymind', exact: true })).toBeVisible();
    const security = await window.evaluate(() => {
      const target = window as unknown as Record<string, unknown>;
      return { require: typeof target.require, process: typeof target.process, bridge: typeof target.joymind };
    });
    expect(security).toEqual({ require: 'undefined', process: 'undefined', bridge: 'object' });
    await window.getByLabel('Workspace 路径').fill(workspace);
    await window.getByLabel('目标', { exact: true }).fill('Create desktop.txt');
    await window.getByRole('button', { name: '启动任务' }).click();
    await expect(window.getByText('待审批操作', { exact: true }).first()).toBeVisible();
    await expect(window.getByText('Diff', { exact: true })).toBeVisible();
    await expect(readFile(join(workspace, 'desktop.txt'), 'utf8')).rejects.toThrow();
    await window.screenshot({ path: test.info().outputPath('approval.png'), fullPage: true });
    await window.getByRole('button', { name: '批准本次操作' }).click();
    await expect(window.getByText('已完成', { exact: true }).first()).toBeVisible();
    await expect(window.getByRole('heading', { name: '执行结果', level: 2 })).toBeVisible();
    await expect(window.getByText('桌面任务已完成', { exact: true })).toBeVisible();
    await expect(window.getByText('文件已写入', { exact: true })).toBeVisible();
    expect(await window.locator('.markdown-content img, .markdown-content script').count()).toBe(0);
    expect(await window.evaluate(() => (window as unknown as Record<string, unknown>).__joymindXss)).toBeUndefined();
    expect(await readFile(join(workspace, 'desktop.txt'), 'utf8')).toBe('Desktop E2E passed');
    await expect(window.getByText('Diff', { exact: true })).toBeVisible();
  } finally {
    await application.close();
  }
});

test('DeepSeek settings, connection testing, language and preferences survive reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'joymind-settings-e2e-'));
  const requests: Array<{ url?: string; authorization?: string; model?: string }> = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      expect(request.url).toBe('/models');
      expect(request.headers.authorization).toBe('Bearer local-deepseek-e2e-key');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }));
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      const payload = JSON.parse(body) as { model?: string };
      requests.push({ url: request.url, authorization: request.headers.authorization, model: payload.model });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"index":0,"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = {
    ...process.env, JOYMIND_USER_DATA: join(directory, 'user-data'), JOYMIND_DB: join(directory, 'joymind.db'),
    DEEPSEEK_API_KEY: 'local-deepseek-e2e-key', DEEPSEEK_BASE_URL: baseUrl,
  };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const executablePath = process.env.JOYMIND_EXECUTABLE;
  const application = await electron.launch(executablePath
    ? { executablePath, args: [], env }
    : { args: [resolve('../../packages/desktop')], env });
  application.process().stderr.on('data', (chunk: Buffer) => console.log(`[electron stderr] ${chunk.toString()}`));
  try {
    const window = await application.firstWindow();
    await expect(window.getByRole('heading', { name: 'Joymind', exact: true })).toBeVisible();
    await window.locator('.top-language select').selectOption('en-US');
    await expect(window.getByText('New task', { exact: true })).toBeVisible();
    await expect.poll(() => application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label) ?? [])).toEqual(['File', 'Edit', 'View', 'Language', 'Help']);
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = window.getByRole('dialog');
    await settings.getByRole('button', { name: 'DeepSeek', exact: true }).click();
    await settings.getByRole('button', { name: 'Fetch models' }).click();
    await expect(settings.getByText('Fetched 2 models. Choose one from the model dropdown.')).toBeVisible();
    await expect(settings.locator('#settings-models option[value="deepseek-v4-pro"]')).toHaveCount(1);
    await settings.getByLabel('Model', { exact: true }).fill('deepseek-v4-pro');
    await settings.getByRole('button', { name: 'Test connection' }).click();
    await expect(settings.getByText('Connected. The model returned a response.')).toBeVisible();
    expect(requests).toEqual([{ url: '/chat/completions', authorization: 'Bearer local-deepseek-e2e-key', model: 'deepseek-v4-pro' }]);
    await settings.getByLabel('Permission mode', { exact: true }).selectOption('auto');
    await settings.getByLabel('Run details', { exact: true }).selectOption('compact');
    await settings.getByLabel('Show tool timeline', { exact: true }).uncheck();
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
    await window.screenshot({ path: test.info().outputPath('settings.png'), fullPage: true });
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(window.getByLabel('Provider', { exact: true })).toHaveValue('deepseek');
    await expect(window.getByLabel('Model', { exact: true })).toHaveValue('deepseek-v4-pro');
    await window.reload();
    await expect(window.getByText('New task', { exact: true })).toBeVisible();
    await expect(window.locator('.top-language select')).toHaveValue('en-US');
    await expect(window.getByLabel('Provider', { exact: true })).toHaveValue('deepseek');
    await expect(window.getByLabel('Model', { exact: true })).toHaveValue('deepseek-v4-pro');
    await expect(window.getByLabel('Permission mode', { exact: true })).toHaveValue('auto');
    const saved = JSON.parse(await readFile(join(directory, 'user-data', 'preferences.json'), 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ locale: 'en-US', provider: 'deepseek', models: { deepseek: 'deepseek-v4-pro' }, permissionMode: 'auto', runDetail: 'compact', showToolTimeline: false });
    expect(JSON.stringify(saved)).not.toContain('local-deepseek-e2e-key');

    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    let settingsDialog = window.getByRole('dialog');
    await settingsDialog.getByRole('button', { name: 'OpenAI', exact: true }).click();
    await settingsDialog.getByLabel('API key', { exact: true }).fill('local-storage-only-key');
    await settingsDialog.getByRole('button', { name: 'Save key' }).click();
    await expect(settingsDialog.getByText('Encrypted and saved', { exact: true })).toBeVisible();
    expect(await readFile(join(directory, 'user-data', 'private', 'provider-secrets.json'), 'utf8')).not.toContain('local-storage-only-key');
    await settingsDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await window.reload();
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    settingsDialog = window.getByRole('dialog');
    await settingsDialog.getByRole('button', { name: 'OpenAI', exact: true }).click();
    await expect(settingsDialog.getByText('Encrypted and saved', { exact: true })).toBeVisible();
    await settingsDialog.getByRole('button', { name: 'Delete key' }).click();
    await expect(settingsDialog.getByText('Not configured', { exact: true })).toBeVisible();
    await settingsDialog.getByLabel('Language', { exact: true }).selectOption('zh-CN');
    await expect(settingsDialog.getByLabel('语言', { exact: true })).toHaveValue('zh-CN');
    await expect.poll(async () => JSON.parse(await readFile(join(directory, 'user-data', 'preferences.json'), 'utf8')).locale).toBe('zh-CN');
    await expect.poll(() => application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label) ?? [])).toEqual(['文件', '编辑', '视图', '语言', '帮助']);
  } finally {
    await application.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
