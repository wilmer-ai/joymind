import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PreferencesStore } from './preferences-store.js';

describe('PreferencesStore', () => {
  it('provides defaults and persists provider, language, workspace and custom model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'joymind-preferences-'));
    const store = new PreferencesStore(directory);
    expect(await store.get()).toMatchObject({ version: 1, locale: 'zh-CN', provider: 'scripted', models: {} });
    const saved = await store.save({
      locale: 'en-US', workspacePath: directory, provider: 'deepseek',
      models: { deepseek: 'deepseek-v4-pro' }, baseUrls: { deepseek: 'http://127.0.0.1:8080' },
      permissionMode: 'auto', runDetail: 'compact', showToolTimeline: false, modelListBaseUrls: { qwen: 'https://workspace.cn-beijing.maas.aliyuncs.com' },
    });
    expect(saved.models.deepseek).toBe('deepseek-v4-pro');
    expect(saved.modelListBaseUrls.qwen).toContain('cn-beijing');
    expect(saved).toMatchObject({ permissionMode: 'auto', runDetail: 'compact', showToolTimeline: false });
    expect((await new PreferencesStore(directory).get()).locale).toBe('en-US');
    expect(await readFile(join(directory, 'preferences.json'), 'utf8')).not.toContain('apiKey');
  });

  it('serializes concurrent saves and reads on Windows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'joymind-preferences-'));
    const store = new PreferencesStore(directory);
    const input = { locale: 'zh-CN' as const, workspacePath: directory, provider: 'deepseek' as const, models: {}, baseUrls: {}, permissionMode: 'auto' as const, runDetail: 'compact' as const, showToolTimeline: false, modelListBaseUrls: {} };
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.save({ ...input, models: { deepseek: `model-${index}` } })));
    await expect(store.save({ ...input, locale: 'en-US' })).resolves.toMatchObject({ locale: 'en-US' });
    expect((await store.get()).locale).toBe('en-US');
  });

  it('never persists unexpected secret fields and preserves damaged files for recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'joymind-preferences-'));
    const store = new PreferencesStore(directory);
    await store.save({
      locale: 'zh-CN', workspacePath: '', provider: 'openai', models: {}, baseUrls: {}, permissionMode: 'auto', runDetail: 'compact', showToolTimeline: false, modelListBaseUrls: {}, apiKey: 'not-allowed',
    } as never);
    const path = join(directory, 'preferences.json');
    expect(await readFile(path, 'utf8')).not.toContain('not-allowed');
    await writeFile(path, '{broken');
    await expect(store.get()).rejects.toThrow('damaged or unreadable');
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });
});
