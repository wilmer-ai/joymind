export type Locale = 'zh-CN' | 'en-US';

export function resolveLocale(value: string | undefined): Locale {
  return value?.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
}

export function localeFromArguments(args: string[], environment = process.env.JOYMIND_LOCALE): Locale {
  const index = args.indexOf('--locale');
  return resolveLocale(index >= 0 ? args[index + 1] : environment);
}

const zh = {
  description: '本地优先、可审计的 Agent 运行时',
  runDescription: '在 Workspace 中启动一个 Agent Run',
  dbOption: 'SQLite 数据库路径',
  jsonOption: '机器可读 JSON 输出',
  localeOption: '界面语言：zh-CN 或 en-US',
  workspaceOption: 'Workspace 路径',
  providerOption: 'Provider ID',
  modelOption: '模型名称',
  approveOption: '批准本次 Run 请求的所有工具',
  permissionOption: '权限模式：ask 逐次询问、auto Agent 评估、autonomous 完全自主',
  runsDescription: '查询或控制历史 Run',
  providersDescription: '查看可用模型服务',
  toolsDescription: '查看可用工具',
  runStarted: (id: string) => `Run ${id}`,
  approvalRequired: '此操作需要审批；请在交互终端重试，或传入 --approve',
  approvalPrompt: (name: string, args: string) => `允许 ${name} ${args}？[y/N] `,
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  queued: '排队中',
  running: '运行中',
  waiting: '等待审批',
  paused: '已暂停',
  interrupted: '已中断',
  tool: '工具',
  done: '完成',
  toolFailed: '工具失败',
};

export type CliMessages = typeof zh;
const en: CliMessages = {
  description: 'Local-first, auditable agent runtime',
  runDescription: 'Start an agent run in a workspace',
  dbOption: 'SQLite database path',
  jsonOption: 'Machine-readable JSON output',
  localeOption: 'Interface language: zh-CN or en-US',
  workspaceOption: 'Workspace path',
  providerOption: 'Provider ID',
  modelOption: 'Model name',
  approveOption: 'Approve all tools requested by this run',
  permissionOption: 'Permission mode: ask, auto (agent assessed), or autonomous',
  runsDescription: 'Inspect or control run history',
  providersDescription: 'List available model providers',
  toolsDescription: 'List available tools',
  runStarted: (id: string) => `Run ${id}`,
  approvalRequired: 'Approval required; rerun in a TTY or pass --approve',
  approvalPrompt: (name: string, args: string) => `Allow ${name} ${args}? [y/N] `,
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  queued: 'queued',
  running: 'running',
  waiting: 'waiting for approval',
  paused: 'paused',
  interrupted: 'interrupted',
  tool: 'tool',
  done: 'done',
  toolFailed: 'tool failed',
};

export function cliMessages(locale: Locale): CliMessages {
  return locale === 'en-US' ? en : zh;
}

export function localizedStatus(status: string, messages: CliMessages): string {
  const labels: Record<string, string> = {
    completed: messages.completed, failed: messages.failed, cancelled: messages.cancelled,
    queued: messages.queued, running: messages.running, waiting_for_approval: messages.waiting,
    waiting_for_input: messages.waiting, paused: messages.paused, interrupted: messages.interrupted,
  };
  return labels[status] ?? status;
}
