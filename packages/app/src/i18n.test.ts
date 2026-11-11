import { describe, expect, it } from 'vitest';
import { messageCatalog } from './i18n';

describe('i18n resources', () => {
  it('keeps Chinese and English resources structurally identical', () => {
    expect(Object.keys(messageCatalog['en-US']).sort()).toEqual(Object.keys(messageCatalog['zh-CN']).sort());
    expect(messageCatalog['en-US'].statuses.completed).toBe('Completed');
    expect(messageCatalog['zh-CN'].statuses.completed).toBe('已完成');
    expect(messageCatalog['en-US'].risks.execute).toBe('Command risk');
  });
});
