import { z } from 'zod';

export const providerIdSchema = z.enum([
  'scripted',
  'openai',
  'deepseek',
  'anthropic',
  'gemini',
  'moonshot',
  'qwen',
  'zhipu',
  'openai-compatible',
]);

export type ProviderId = z.infer<typeof providerIdSchema>;
export type RemoteProviderId = Exclude<ProviderId, 'scripted'>;

export const providerDefinitionSchema = z.object({
  id: providerIdSchema,
  name: z.string().min(1),
  protocol: z.enum(['scripted', 'openai-compatible', 'anthropic']),
  modelList: z.enum(['none', 'openai', 'anthropic', 'gemini', 'qwen']),
  defaultBaseUrl: z.url().optional(),
  defaultModel: z.string().min(1),
  models: z.array(z.string().min(1)).min(1),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  baseUrlEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  docsUrl: z.url().optional(),
  customEndpoint: z.boolean(),
}).strict();

export type ProviderDefinition = z.infer<typeof providerDefinitionSchema>;

export const providerCatalog: readonly ProviderDefinition[] = parseProviderCatalog([
  {
    id: 'scripted', name: 'Scripted (offline)', protocol: 'scripted', modelList: 'none', defaultModel: 'scripted-default',
    models: ['scripted-default'], customEndpoint: false,
  },
  {
    id: 'openai', name: 'OpenAI', protocol: 'openai-compatible', modelList: 'openai', defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6.1-sol', models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-terra'],
    apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL', docsUrl: 'https://platform.openai.com/docs/models', customEndpoint: true,
  },
  {
    id: 'deepseek', name: 'DeepSeek', protocol: 'openai-compatible', modelList: 'openai', defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'],
    apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrlEnv: 'DEEPSEEK_BASE_URL', docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing', customEndpoint: true,
  },
  {
    id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', modelList: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-5-5', models: ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview', customEndpoint: true,
  },
  {
    id: 'gemini', name: 'Google Gemini', protocol: 'openai-compatible', modelList: 'gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.8-flash', models: ['gemini-3.8-flash', 'gemini-4-carbon', 'gemini-3.5-flash-lite'],
    apiKeyEnv: 'GEMINI_API_KEY', baseUrlEnv: 'GEMINI_BASE_URL', docsUrl: 'https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-api-dev/SKILL.md', customEndpoint: true,
  },
  {
    id: 'moonshot', name: 'Moonshot Kimi', protocol: 'openai-compatible', modelList: 'openai', defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k3.1-pro', models: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3'],
    apiKeyEnv: 'MOONSHOT_API_KEY', baseUrlEnv: 'MOONSHOT_BASE_URL', docsUrl: 'https://platform.kimi.com/docs/models', customEndpoint: true,
  },
  {
    id: 'qwen', name: 'Alibaba Qwen', protocol: 'openai-compatible', modelList: 'qwen', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.7-plus', models: ['qwen3.7-plus', 'qwen3.8-max', 'qwen3.8-flash', 'qwen4-max-preview'],
    apiKeyEnv: 'DASHSCOPE_API_KEY', baseUrlEnv: 'DASHSCOPE_BASE_URL', docsUrl: 'https://help.aliyun.com/zh/model-studio/list-models', customEndpoint: true,
  },
  {
    id: 'zhipu', name: 'Zhipu GLM', protocol: 'openai-compatible', modelList: 'none', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.3', models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'],
    apiKeyEnv: 'ZHIPUAI_API_KEY', baseUrlEnv: 'ZHIPUAI_BASE_URL', docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/model-overview', customEndpoint: true,
  },
  {
    id: 'openai-compatible', name: 'Custom OpenAI-compatible', protocol: 'openai-compatible', modelList: 'openai', defaultModel: 'your-model-id',
    models: ['your-model-id'], apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY', baseUrlEnv: 'OPENAI_COMPATIBLE_BASE_URL', customEndpoint: true,
  },
]);

function parseProviderCatalog(items: unknown): ProviderDefinition[] {
  const result = z.array(providerDefinitionSchema).parse(items);
  if (new Set(result.map((item) => item.id)).size !== providerIdSchema.options.length || result.length !== providerIdSchema.options.length) {
    throw new Error('Provider catalog must define every provider ID exactly once.');
  }
  return result;
}

export function getProviderDefinition(id: string): ProviderDefinition {
  const provider = providerCatalog.find((item) => item.id === id);
  if (!provider) throw new Error(`Unknown model provider: ${id}`);
  return provider;
}

export function remoteProviderIds(): RemoteProviderId[] {
  return providerCatalog.filter((provider) => provider.id !== 'scripted').map((provider) => provider.id as RemoteProviderId);
}
