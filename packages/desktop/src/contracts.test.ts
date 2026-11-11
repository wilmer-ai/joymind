import { describe, expect, it } from 'vitest';
import { commandSchema, connectionTestSchema, preferencesInputSchema, secretSaveSchema, startRunSchema, subscribeSchema } from './contracts.js';

describe('desktop IPC schemas', () => {
  it('rejects unknown fields and malformed run commands', () => {
    expect(() => startRunSchema.parse({ workspacePath: '.', goal: 'test', provider: 'scripted', model: 'scripted-default', permissionMode: 'ask', apiKey: 'not-allowed' })).toThrow();
    expect(() => commandSchema.parse({ runId: 'run', command: { commandId: 'command', type: 'approve' } })).toThrow();
    expect(() => subscribeSchema.parse({ subscriptionId: 'sub', runId: 'run', afterSeq: -1 })).toThrow();
  });

  it('accepts provider secrets only through the dedicated schema', () => {
    expect(secretSaveSchema.parse({ provider: 'openai', apiKey: 'secret' })).toEqual({ provider: 'openai', apiKey: 'secret' });
    expect(secretSaveSchema.parse({ provider: 'deepseek', apiKey: 'secret' })).toMatchObject({ provider: 'deepseek' });
    expect(() => secretSaveSchema.parse({ provider: 'scripted', apiKey: 'secret' })).toThrow();
    expect(() => secretSaveSchema.parse({ provider: 'openai', apiKey: '' })).toThrow();
  });

  it('validates bilingual preferences and DeepSeek connection settings', () => {
    expect(preferencesInputSchema.parse({
      locale: 'en-US', workspacePath: 'C:\\Projects\\demo', provider: 'deepseek',
      models: { deepseek: 'deepseek-v4-pro' }, baseUrls: { deepseek: 'https://api.deepseek.com' },
      modelListBaseUrls: { qwen: 'https://workspace.cn-beijing.maas.aliyuncs.com' },
      permissionMode: 'auto', runDetail: 'compact', showToolTimeline: false,
    })).toMatchObject({ locale: 'en-US', provider: 'deepseek' });
    expect(connectionTestSchema.parse({ provider: 'deepseek', model: 'deepseek-flash' })).toMatchObject({ provider: 'deepseek' });
    expect(connectionTestSchema.parse({ provider: 'qwen', model: 'qwen3.7-plus', modelListBaseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com' })).toMatchObject({ provider: 'qwen' });
    expect(() => connectionTestSchema.parse({ provider: 'deepseek', model: 'x', baseUrl: 'not-a-url' })).toThrow();
    expect(() => preferencesInputSchema.parse({ locale: 'fr-FR', workspacePath: '', provider: 'openai', models: {}, baseUrls: {} })).toThrow();
  });
});
