import { contextBridge, ipcRenderer } from 'electron';
import type { PermissionMode, RunCommand, RunEvent, RunSnapshot } from '@joymind/core';

type ProviderId = 'scripted' | 'openai' | 'deepseek' | 'anthropic' | 'gemini' | 'moonshot' | 'qwen' | 'zhipu' | 'openai-compatible';
type SecretProviderId = Exclude<ProviderId, 'scripted'>;
type Locale = 'zh-CN' | 'en-US';
type MenuAction = { action: 'new-task' | 'open-settings' | 'select-workspace' } | { action: 'set-locale'; locale: Locale };

interface StartRunInput {
  workspacePath: string;
  goal: string;
  provider: ProviderId;
  model: string;
  permissionMode: PermissionMode;
}

interface SecretSettings {
  encryptionAvailable: boolean;
  providers: Array<{ provider: SecretProviderId; configured: boolean; source: 'encrypted' | 'environment' | 'none' }>;
}

interface Preferences {
  locale: Locale;
  workspacePath: string;
  provider: ProviderId;
  models: Partial<Record<ProviderId, string>>;
  baseUrls: Partial<Record<SecretProviderId, string>>;
  modelListBaseUrls: Partial<Record<SecretProviderId, string>>;
  permissionMode: PermissionMode;
  runDetail: 'detailed' | 'compact';
  showToolTimeline: boolean;
}

interface ProviderDefinition {
  id: ProviderId;
  name: string;
  protocol: 'scripted' | 'openai-compatible' | 'anthropic';
  modelList: 'none' | 'openai' | 'anthropic' | 'gemini' | 'qwen';
  defaultBaseUrl?: string;
  defaultModel: string;
  models: string[];
  apiKeyEnv?: string;
  baseUrlEnv?: string;
  docsUrl?: string;
  customEndpoint: boolean;
}

interface Subscription {
  onEvent: (event: RunEvent) => void;
  onError: (error: { message: string }) => void;
}

const subscriptions = new Map<string, Subscription>();
let nextSubscription = 0;

function subscriptionId(): string {
  nextSubscription += 1;
  return `${Date.now()}-${nextSubscription}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '事件订阅失败。';
}

ipcRenderer.on('joymind:run:event', (_event, value: unknown) => {
  if (typeof value !== 'object' || value === null) return;
  const envelope = value as { subscriptionId?: unknown; event?: unknown };
  if (typeof envelope.subscriptionId !== 'string') return;
  subscriptions.get(envelope.subscriptionId)?.onEvent(envelope.event as RunEvent);
});

ipcRenderer.on('joymind:run:subscription-error', (_event, value: unknown) => {
  if (typeof value !== 'object' || value === null) return;
  const envelope = value as { subscriptionId?: unknown; error?: unknown };
  if (typeof envelope.subscriptionId !== 'string') return;
  const message = typeof envelope.error === 'object' && envelope.error !== null && 'message' in envelope.error && typeof envelope.error.message === 'string'
    ? envelope.error.message
    : '事件订阅失败。';
  subscriptions.get(envelope.subscriptionId)?.onError({ message });
});

function menuAction(value: unknown): MenuAction | undefined {
  if (typeof value !== 'object' || value === null || !('action' in value) || typeof value.action !== 'string') return undefined;
  if (['new-task', 'open-settings', 'select-workspace'].includes(value.action)) return { action: value.action } as MenuAction;
  if (value.action === 'set-locale' && 'locale' in value && ['zh-CN', 'en-US'].includes(String(value.locale))) {
    return { action: 'set-locale', locale: value.locale as Locale };
  }
  return undefined;
}

function unsubscribe(id: string): void {
  subscriptions.delete(id);
  void ipcRenderer.invoke('joymind:run:unsubscribe', { subscriptionId: id }).catch(() => undefined);
}

contextBridge.exposeInMainWorld('joymind', {
  startRun: (input: StartRunInput): Promise<RunSnapshot> => ipcRenderer.invoke('joymind:run:start', input) as Promise<RunSnapshot>,
  getRun: (runId: string): Promise<RunSnapshot> => ipcRenderer.invoke('joymind:run:get', { runId }) as Promise<RunSnapshot>,
  listRuns: (input: { limit: number; offset: number }): Promise<{ runs: RunSnapshot[]; hasMore: boolean }> => ipcRenderer.invoke('joymind:run:list', input) as Promise<{ runs: RunSnapshot[]; hasMore: boolean }>,
  command: (runId: string, command: RunCommand): Promise<RunSnapshot> => ipcRenderer.invoke('joymind:run:command', { runId, command }) as Promise<RunSnapshot>,
  getCatalog: (): Promise<ProviderDefinition[]> => ipcRenderer.invoke('joymind:providers:catalog') as Promise<ProviderDefinition[]>,
  selectWorkspace: (): Promise<{ path: string | null }> => ipcRenderer.invoke('joymind:workspace:select') as Promise<{ path: string | null }>,
  openExternal: (url: string): Promise<{ opened: boolean }> => ipcRenderer.invoke('joymind:external:open', { url }) as Promise<{ opened: boolean }>,
  testConnection: (input: { provider: SecretProviderId; model: string; baseUrl?: string; apiKey?: string }): Promise<{ connected: boolean }> => ipcRenderer.invoke('joymind:providers:test', input) as Promise<{ connected: boolean }>,
  listModels: (input: { provider: SecretProviderId; baseUrl?: string; modelListBaseUrl?: string; apiKey?: string }): Promise<{ models: string[] }> => ipcRenderer.invoke('joymind:providers:models', input) as Promise<{ models: string[] }>,
  onMenuAction: (listener: (action: MenuAction) => void): (() => void) => {
    const handler = (_event: unknown, value: unknown) => {
      const action = menuAction(value);
      if (action) listener(action);
    };
    ipcRenderer.on('joymind:menu:action', handler);
    return () => { ipcRenderer.removeListener('joymind:menu:action', handler); };
  },
  preferences: {
    get: (): Promise<Preferences> => ipcRenderer.invoke('joymind:preferences:get') as Promise<Preferences>,
    save: (input: Preferences): Promise<Preferences> => ipcRenderer.invoke('joymind:preferences:save', {
      locale: input.locale, workspacePath: input.workspacePath, provider: input.provider, models: input.models, baseUrls: input.baseUrls, modelListBaseUrls: input.modelListBaseUrls,
      permissionMode: input.permissionMode, runDetail: input.runDetail, showToolTimeline: input.showToolTimeline,
    }) as Promise<Preferences>,
  },
  subscribe: (runId: string, afterSeq: number, onEvent: (event: RunEvent) => void, onError: (error: { message: string }) => void): (() => void) => {
    const id = subscriptionId();
    subscriptions.set(id, { onEvent, onError });
    let active = true;
    void ipcRenderer.invoke('joymind:run:subscribe', { subscriptionId: id, runId, afterSeq }).catch((error: unknown) => {
      if (active) onError({ message: errorMessage(error) });
      subscriptions.delete(id);
    });
    return () => {
      if (!active) return;
      active = false;
      unsubscribe(id);
    };
  },
  secrets: {
    getSettings: (): Promise<SecretSettings> => ipcRenderer.invoke('joymind:secrets:settings') as Promise<SecretSettings>,
    save: (provider: SecretProviderId, apiKey: string): Promise<SecretSettings> => ipcRenderer.invoke('joymind:secrets:save', { provider, apiKey }) as Promise<SecretSettings>,
    remove: (provider: SecretProviderId): Promise<SecretSettings> => ipcRenderer.invoke('joymind:secrets:delete', { provider }) as Promise<SecretSettings>,
  },
});
