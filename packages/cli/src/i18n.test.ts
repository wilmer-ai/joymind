import { describe, expect, it } from 'vitest';
import { cliMessages, localeFromArguments, localizedStatus, resolveLocale } from './i18n.js';

describe('CLI locale', () => {
  it('selects explicit language before environment fallback', () => {
    expect(localeFromArguments(['node', 'cli', '--locale', 'en-US'], 'zh-CN')).toBe('en-US');
    expect(localeFromArguments(['node', 'cli'], 'en-US')).toBe('en-US');
    expect(resolveLocale('fr-FR')).toBe('zh-CN');
    expect(localizedStatus('waiting_for_approval', cliMessages('en-US'))).toBe('waiting for approval');
    expect(localizedStatus('waiting_for_approval', cliMessages('zh-CN'))).toBe('等待审批');
  });
});
