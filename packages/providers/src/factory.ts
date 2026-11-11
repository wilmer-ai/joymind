import { JoymindError } from '@joymind/core';
import type { ModelProvider } from '@joymind/core';
import { z } from 'zod';
import { AnthropicProvider } from './anthropic.js';
import { getProviderDefinition, providerIdSchema } from './catalog.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { ScriptedProvider } from './scripted.js';

export const providerConnectionConfigSchema = z.object({
  provider: providerIdSchema,
  apiKey: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
  modelListBaseUrl: z.url().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
}).strict();

export type ProviderConnectionConfig = z.infer<typeof providerConnectionConfigSchema>;

export function createModelProvider(config: ProviderConnectionConfig): ModelProvider {
  const parsed = providerConnectionConfigSchema.parse(config);
  const definition = getProviderDefinition(parsed.provider);
  if (definition.protocol === 'scripted') return new ScriptedProvider();
  const baseUrl = parsed.baseUrl ?? definition.defaultBaseUrl;
  if (!baseUrl) {
    throw new JoymindError({ code: 'configuration_error', message: `${definition.name} requires a base URL.`, retryable: false });
  }
  const adapterConfig = {
    ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
    baseUrl,
    ...(parsed.timeoutMs ? { timeoutMs: parsed.timeoutMs } : {}),
    ...(parsed.maxRetries !== undefined ? { maxRetries: parsed.maxRetries } : {}),
  };
  return definition.protocol === 'anthropic'
    ? new AnthropicProvider(adapterConfig)
    : new OpenAICompatibleProvider(adapterConfig);
}

export async function testModelConnection(config: ProviderConnectionConfig, model: string): Promise<void> {
  const parsed = providerConnectionConfigSchema.parse(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Connection test timed out', 'TimeoutError')), 20_000);
  try {
    const provider = createModelProvider({ ...parsed, timeoutMs: 20_000, maxRetries: 0 });
    for await (const event of provider.stream({
      model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      tools: [],
      maxOutputTokens: 16,
      signal: controller.signal,
    })) {
      if (event.type === 'done') return;
    }
    throw new JoymindError({ code: 'invalid_stream', message: 'Connection test ended without a completion event.', retryable: true });
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof DOMException && controller.signal.reason.name === 'TimeoutError') {
      throw new JoymindError({ code: 'timeout', message: 'Connection test timed out after 20 seconds.', retryable: true });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
