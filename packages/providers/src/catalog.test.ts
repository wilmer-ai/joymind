import { describe, expect, it } from 'vitest';
import { getProviderDefinition, providerCatalog, providerIdSchema } from './catalog.js';
import { createModelProvider, testModelConnection } from './factory.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { openAiChunk, withServer } from './test-server.js';

describe('provider catalog', () => {
  it('defines every provider once, including DeepSeek and a custom endpoint', () => {
    expect(providerCatalog.map((provider) => provider.id).sort()).toEqual([...providerIdSchema.options].sort());
    expect(getProviderDefinition('deepseek')).toMatchObject({
      protocol: 'openai-compatible', modelList: 'openai', defaultModel: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY',
    });
    expect(getProviderDefinition('deepseek').models).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(getProviderDefinition('deepseek').models).not.toContain('deepseek-chat');
    expect(getProviderDefinition('deepseek').models).not.toContain('deepseek-reasoner');
    expect(getProviderDefinition('openai-compatible').defaultBaseUrl).toBeUndefined();
  });

  it('creates DeepSeek through the shared OpenAI-compatible adapter', () => {
    expect(createModelProvider({ provider: 'deepseek' })).toBeInstanceOf(OpenAICompatibleProvider);
    expect(() => createModelProvider({ provider: 'openai-compatible' })).toThrow('requires a base URL');
  });

  it('tests a custom DeepSeek model over real HTTP/SSE without retaining response content', async () => {
    await withServer((request, response, body) => {
      expect(request.url).toBe('/chat/completions');
      expect(request.headers.authorization).toBe('Bearer deepseek-test-key');
      expect(JSON.parse(body)).toMatchObject({ model: 'deepseek-v4-pro', max_tokens: 16, tools: [] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`${openAiChunk({ content: 'private test response' })}data: [DONE]\n\n`);
    }, async (baseUrl) => {
      await expect(testModelConnection({ provider: 'deepseek', baseUrl, apiKey: 'deepseek-test-key' }, 'deepseek-v4-pro')).resolves.toBeUndefined();
    });
  });
});
