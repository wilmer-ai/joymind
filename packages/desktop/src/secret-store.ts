import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import { JoymindError } from '@joymind/core';
import { getProviderDefinition, remoteProviderIds } from '@joymind/providers';
import { z } from 'zod';
import type { z as zod } from 'zod';
import { secretProviderSchema } from './contracts.js';

const secretFileSchema = z.object({
  version: z.literal(1),
  secrets: z.partialRecord(secretProviderSchema, z.string().min(1)),
}).strict();

type SecretFile = zod.infer<typeof secretFileSchema>;
type SecretProvider = zod.infer<typeof secretProviderSchema>;

const emptyFile = (): SecretFile => ({ version: 1, secrets: {} });

function storageError(message: string): JoymindError {
  return new JoymindError({ code: 'configuration_error', message, retryable: false });
}

function environmentKey(provider: SecretProvider): string | undefined {
  const variable = getProviderDefinition(provider).apiKeyEnv;
  return variable ? process.env[variable] : undefined;
}

export class ProviderSecretStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, 'private', 'provider-secrets.json');
  }

  async settings() {
    const file = await this.read();
    return {
      encryptionAvailable: await safeStorage.isAsyncEncryptionAvailable(),
      providers: remoteProviderIds().map((provider) => ({
        provider,
        configured: file.secrets[provider] !== undefined || Boolean(environmentKey(provider)),
        source: file.secrets[provider] !== undefined ? 'encrypted' : environmentKey(provider) ? 'environment' : 'none',
      })),
    };
  }

  async save(provider: SecretProvider, apiKey: string): Promise<void> {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw storageError('系统安全存储不可用，未保存密钥。');
    const file = await this.read();
    file.secrets[provider] = (await safeStorage.encryptStringAsync(apiKey)).toString('base64');
    await this.write(file);
  }

  async remove(provider: SecretProvider): Promise<void> {
    const file = await this.read();
    delete file.secrets[provider];
    await this.write(file);
  }

  async get(provider: SecretProvider): Promise<string | undefined> {
    const file = await this.read();
    const encrypted = file.secrets[provider];
    if (!encrypted) return undefined;
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw storageError('系统安全存储不可用，无法读取 Provider 密钥。');
    try {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'));
      if (decrypted.shouldReEncrypt) {
        file.secrets[provider] = (await safeStorage.encryptStringAsync(decrypted.result)).toString('base64');
        await this.write(file);
      }
      return decrypted.result;
    } catch {
      throw storageError('Provider 密钥无法解密，请重新配置。');
    }
  }

  private async read(): Promise<SecretFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      return secretFileSchema.parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
      throw storageError('Provider 密钥存储损坏或不可读，请重新配置。');
    }
  }

  private async write(file: SecretFile): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(file), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(temporary);
      } catch { /* Preserve the original storage error. */ }
      throw error;
    }
  }
}
