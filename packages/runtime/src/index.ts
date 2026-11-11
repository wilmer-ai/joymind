import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { DefaultAgentRuntime, type ModelProvider } from '@joymind/core';
import {
  createModelProvider, providerCatalog, ScriptedProvider,
  type AnthropicProviderConfig, type OpenAICompatibleProviderConfig, type ProviderConnectionConfig, type ScriptedResponse,
} from '@joymind/providers';
import { SqliteRunStore } from '@joymind/storage';
import { createBuiltinTools } from '@joymind/tools';

export interface JoymindRuntimeOptions {
  dbPath?: string;
  openai?: OpenAICompatibleProviderConfig;
  anthropic?: AnthropicProviderConfig;
  providerConfigs?: Partial<Record<string, Omit<ProviderConnectionConfig, 'provider'>>>;
  scriptedResponses?: ScriptedResponse[];
  recover?: boolean;
}

class EchoProvider implements ModelProvider {
  async capabilities() { return { streaming: true, toolCalling: true, structuredOutput: false, vision: false }; }
  async *stream(request: Parameters<ModelProvider['stream']>[0]) {
    const goal = request.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
    yield { type: 'text_delta' as const, text: `Joymind 离线 Provider 已就绪。收到目标：${goal}\n配置 OpenAI、Anthropic 或 JOYMIND_SCRIPT 后可执行模型驱动任务。` };
    yield { type: 'done' as const, reason: 'stop' };
  }
}

export async function createJoymindRuntime(options: JoymindRuntimeOptions = {}) {
  const dbPath = options.dbPath ?? process.env.JOYMIND_DB ?? resolve(homedir(), '.joymind', 'joymind.db');
  if (dbPath !== ':memory:') await mkdir(dirname(dbPath), { recursive: true });
  const store = new SqliteRunStore(dbPath);
  let scriptedResponses = options.scriptedResponses;
  if (!scriptedResponses && process.env.JOYMIND_SCRIPT) {
    scriptedResponses = JSON.parse(await readFile(resolve(process.env.JOYMIND_SCRIPT), 'utf8')) as ScriptedResponse[];
  }
  const scripted: ModelProvider = scriptedResponses ? new ScriptedProvider({ queue: scriptedResponses }) : new EchoProvider();
  const providers: Record<string, ModelProvider> = { scripted };
  for (const definition of providerCatalog) {
    if (definition.id === 'scripted') continue;
    const legacy = definition.id === 'openai' ? options.openai : definition.id === 'anthropic' ? options.anthropic : undefined;
    const configured = options.providerConfigs?.[definition.id] ?? legacy;
    const baseUrl = configured?.baseUrl
      ?? (definition.baseUrlEnv ? process.env[definition.baseUrlEnv] : undefined)
      ?? definition.defaultBaseUrl;
    if (!baseUrl) continue;
    const apiKey = configured?.apiKey ?? (definition.apiKeyEnv ? process.env[definition.apiKeyEnv] : undefined);
    providers[definition.id] = createModelProvider({
      provider: definition.id, baseUrl, ...configured,
      ...(apiKey ? { apiKey } : {}),
    });
  }
  const runtime = new DefaultAgentRuntime({ store, providers, tools: createBuiltinTools() });
  if (options.recover === true) await runtime.recoverInterrupted();
  return {
    runtime, store, providers,
    close: async () => store.close(),
  };
}

export { DefaultAgentRuntime } from '@joymind/core';
export { MemoryRunStore, SqliteRunStore } from '@joymind/storage';
export { AnthropicProvider, OpenAICompatibleProvider, ScriptedProvider } from '@joymind/providers';
export { createBuiltinTools } from '@joymind/tools';
export type JoymindRuntimeContext = Awaited<ReturnType<typeof createJoymindRuntime>>;
