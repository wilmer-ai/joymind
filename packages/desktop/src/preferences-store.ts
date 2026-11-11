import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JoymindError } from '@joymind/core';
import type { z } from 'zod';
import { preferencesFileSchema, preferencesInputSchema } from './contracts.js';

export type PreferencesInput = z.infer<typeof preferencesInputSchema>;
export type PreferencesFile = z.infer<typeof preferencesFileSchema>;

export class PreferencesStore {
  private readonly filePath: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, 'preferences.json');
  }

  async get(): Promise<PreferencesFile> {
    await this.pending;
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      return preferencesFileSchema.parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return preferencesFileSchema.parse({ version: 1 });
      }
      throw new JoymindError({ code: 'configuration_error', message: 'Preferences are damaged or unreadable.', retryable: false });
    }
  }

  async save(input: PreferencesInput): Promise<PreferencesFile> {
    const operation = this.pending.then(() => this.write(input));
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async write(input: PreferencesInput): Promise<PreferencesFile> {
    const candidate = {
      locale: input.locale, workspacePath: input.workspacePath, provider: input.provider,
      models: input.models, baseUrls: input.baseUrls, modelListBaseUrls: input.modelListBaseUrls,
      permissionMode: input.permissionMode, runDetail: input.runDetail, showToolTimeline: input.showToolTimeline,
    };
    const file = preferencesFileSchema.parse({ version: 1, ...preferencesInputSchema.parse(candidate) });
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(file), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
      return file;
    } catch (error) {
      try { await unlink(temporary); } catch { /* Preserve the original storage error. */ }
      throw error;
    }
  }
}
