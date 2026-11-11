import type { MenuItemConstructorOptions } from 'electron';

export type MenuLocale = 'zh-CN' | 'en-US';

export interface MenuActions {
  newTask(): void;
  openSettings(): void;
  selectWorkspace(): void;
  setLocale(locale: MenuLocale): void;
  about(): void;
}

const labels = {
  'zh-CN': {
    file: '文件', newTask: '新建任务', selectWorkspace: '选择 Workspace…', settings: '设置…', quit: '退出',
    edit: '编辑', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
    view: '视图', reload: '重新加载', devTools: '切换开发者工具', resetZoom: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullscreen: '切换全屏',
    language: '语言', chinese: '简体中文', english: 'English', help: '帮助', about: '关于 Joymind',
  },
  'en-US': {
    file: 'File', newTask: 'New Task', selectWorkspace: 'Choose Workspace…', settings: 'Settings…', quit: 'Quit',
    edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    view: 'View', reload: 'Reload', devTools: 'Toggle Developer Tools', resetZoom: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Toggle Full Screen',
    language: 'Language', chinese: '简体中文', english: 'English', help: 'Help', about: 'About Joymind',
  },
} as const;

export function applicationMenuTemplate(locale: MenuLocale, actions: MenuActions): MenuItemConstructorOptions[] {
  const t = labels[locale];
  const template: MenuItemConstructorOptions[] = [
    {
      label: t.file,
      submenu: [
        { label: t.newTask, accelerator: 'CmdOrCtrl+N', click: () => actions.newTask() },
        { label: t.selectWorkspace, accelerator: 'CmdOrCtrl+O', click: () => actions.selectWorkspace() },
        { type: 'separator' },
        { label: t.settings, accelerator: 'CmdOrCtrl+,', click: () => actions.openSettings() },
        { type: 'separator' },
        { role: 'quit', label: t.quit },
      ],
    },
    {
      label: t.edit,
      submenu: [
        { role: 'undo', label: t.undo }, { role: 'redo', label: t.redo }, { type: 'separator' },
        { role: 'cut', label: t.cut }, { role: 'copy', label: t.copy }, { role: 'paste', label: t.paste },
        { role: 'selectAll', label: t.selectAll },
      ],
    },
    {
      label: t.view,
      submenu: [
        { role: 'reload', label: t.reload }, { role: 'toggleDevTools', label: t.devTools }, { type: 'separator' },
        { role: 'resetZoom', label: t.resetZoom }, { role: 'zoomIn', label: t.zoomIn }, { role: 'zoomOut', label: t.zoomOut },
        { type: 'separator' }, { role: 'togglefullscreen', label: t.fullscreen },
      ],
    },
    {
      label: t.language,
      submenu: [
        { label: t.chinese, type: 'radio', checked: locale === 'zh-CN', click: () => actions.setLocale('zh-CN') },
        { label: t.english, type: 'radio', checked: locale === 'en-US', click: () => actions.setLocale('en-US') },
      ],
    },
    { label: t.help, submenu: [{ label: t.about, click: () => actions.about() }] },
  ];
  if (process.platform === 'darwin') {
    template.unshift({ label: 'Joymind', submenu: [{ label: t.about, click: () => actions.about() }] });
  }
  return template;
}
