import { describe, expect, it, vi } from 'vitest';
import { applicationMenuTemplate } from './menu.js';

const actions = { newTask: vi.fn(), openSettings: vi.fn(), selectWorkspace: vi.fn(), setLocale: vi.fn(), about: vi.fn() };

describe('application menu', () => {
  it('uses localized native labels and language radio state', () => {
    const chinese = applicationMenuTemplate('zh-CN', actions);
    expect(chinese.map((item) => item.label)).toEqual(['文件', '编辑', '视图', '语言', '帮助']);
    const language = chinese[3]?.submenu;
    expect(Array.isArray(language) && language[0]).toMatchObject({ label: '简体中文', checked: true });
    const english = applicationMenuTemplate('en-US', actions);
    expect(english.map((item) => item.label)).toEqual(['File', 'Edit', 'View', 'Language', 'Help']);
    expect(english[0]?.label).not.toBe(chinese[0]?.label);
  });

  it('keeps menu actions limited to explicit callbacks', () => {
    const template = applicationMenuTemplate('en-US', actions);
    const file = template[0]?.submenu;
    if (!Array.isArray(file)) throw new Error('Missing file submenu');
    const item = file[0];
    if (!item?.click) throw new Error('Missing new task action');
    item.click({} as never, undefined, {});
    expect(actions.newTask).toHaveBeenCalled();
  });
});
