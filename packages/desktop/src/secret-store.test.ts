import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from(`encrypted:${value}`),
    decryptStringAsync: async (value: Buffer) => {
      const decoded = value.toString();
      if (!decoded.startsWith('encrypted:')) throw new Error('Cannot decrypt');
      return { result: decoded.slice('encrypted:'.length), shouldReEncrypt: false };
    },
  },
}));

import { ProviderSecretStore } from './secret-store.js';

describe('ProviderSecretStore', () => {
  beforeEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('supports DeepSeek without persisting plaintext and preserves existing providers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'joymind-secrets-'));
    const privateDirectory = join(directory, 'private');
    await mkdir(privateDirectory);
    await writeFile(join(privateDirectory, 'provider-secrets.json'), JSON.stringify({
      version: 1, secrets: { openai: Buffer.from('encrypted:old-openai').toString('base64') },
    }));
    const store = new ProviderSecretStore(directory);
    await store.save('deepseek', 'deepseek-plaintext-test');
    expect(await store.get('deepseek')).toBe('deepseek-plaintext-test');
    expect(await store.get('openai')).toBe('old-openai');
    expect(await readFile(join(privateDirectory, 'provider-secrets.json'), 'utf8')).not.toContain('deepseek-plaintext-test');
    const settings = await store.settings();
    expect(settings.providers.find((provider) => provider.provider === 'deepseek')).toMatchObject({ configured: true, source: 'encrypted' });
    await store.remove('deepseek');
    expect(await store.get('deepseek')).toBeUndefined();
  });

  it('reports environment credentials separately without writing them', async () => {
    process.env.DEEPSEEK_API_KEY = 'environment-test-key';
    const directory = await mkdtemp(join(tmpdir(), 'joymind-secrets-'));
    const settings = await new ProviderSecretStore(directory).settings();
    expect(settings.providers.find((provider) => provider.provider === 'deepseek')).toMatchObject({ configured: true, source: 'environment' });
  });
});
