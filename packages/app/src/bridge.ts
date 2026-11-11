import type { PermissionMode, RunCommand, RunEvent, RunSnapshot } from '@joymind/core';

export type ProviderId = 'scripted' | 'openai' | 'deepseek' | 'anthropic' | 'gemini' | 'moonshot' | 'qwen' | 'zhipu' | 'openai-compatible';
export type SecretProviderId = Exclude<ProviderId, 'scripted'>;
export type Locale = 'zh-CN' | 'en-US';
export type MenuAction = { action: 'new-task' | 'open-settings' | 'select-workspace' } | { action: 'set-locale'; locale: Locale };

export interface ProviderDefinition {
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

export interface Preferences {
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

export interface StartRunInput {
  workspacePath: string;
  goal: string;
  provider: ProviderId;
  model: string;
  permissionMode: PermissionMode;
}

export interface RunHistoryPage {
  runs: RunSnapshot[];
  hasMore: boolean;
}

export interface ProviderSecretStatus {
  provider: SecretProviderId;
  configured: boolean;
  source: 'encrypted' | 'environment' | 'none';
}

export interface SecretSettings {
  encryptionAvailable: boolean;
  providers: ProviderSecretStatus[];
}

export interface RunSubscriptionError {
  message: string;
}

export type Unsubscribe = () => void;

export interface JoymindBridge {
  startRun(input: StartRunInput): Promise<RunSnapshot>;
  getRun(runId: string): Promise<RunSnapshot>;
  listRuns(input: { limit: number; offset: number }): Promise<RunHistoryPage>;
  command(runId: string, command: RunCommand): Promise<RunSnapshot>;
  getCatalog(): Promise<ProviderDefinition[]>;
  selectWorkspace(): Promise<{ path: string | null }>;
  openExternal(url: string): Promise<{ opened: boolean }>;
  testConnection(input: { provider: SecretProviderId; model: string; baseUrl?: string; apiKey?: string }): Promise<{ connected: boolean }>;
  listModels(input: { provider: SecretProviderId; baseUrl?: string; modelListBaseUrl?: string; apiKey?: string }): Promise<{ models: string[] }>;
  onMenuAction(listener: (action: MenuAction) => void): Unsubscribe;
  preferences: {
    get(): Promise<Preferences>;
    save(input: Preferences): Promise<Preferences>;
  };
  subscribe(
    runId: string,
    afterSeq: number,
    onEvent: (event: RunEvent) => void,
    onError: (error: RunSubscriptionError) => void,
  ): Unsubscribe;
  secrets: {
    getSettings(): Promise<SecretSettings>;
    save(provider: SecretProviderId, apiKey: string): Promise<SecretSettings>;
    remove(provider: SecretProviderId): Promise<SecretSettings>;
  };
}

declare global {
  interface Window {
    joymind: JoymindBridge;
  }
}

export function errorMessage(error: unknown, fallback = 'Operation failed.'): string {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }
  return fallback;
}
