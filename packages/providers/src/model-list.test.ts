import { describe, expect, it } from 'vitest';
import { listProviderModels } from './model-list.js';
import { caughtError, withServer } from './test-server.js';

describe('listProviderModels', () => {
  it('lists DeepSeek models through the OpenAI-compatible endpoint', async () => {
    await withServer((request, response) => {
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/models');
      expect(request.headers.authorization).toBe('Bearer list-secret');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] }));
    }, async (baseUrl) => {
      await expect(listProviderModels({ provider: 'deepseek', baseUrl, apiKey: 'list-secret' })).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    });
  });

  it('requests only active Anthropic models and accepts native metadata', async () => {
    await withServer((request, response) => {
      expect(request.url).toBe('/v1/models?limit=1000&lifecycle=active');
      expect(request.headers.authorization).toBe('Bearer anthropic-list-secret');
      expect(request.headers['anthropic-version']).toBe('2026-10-21');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [
        { id: 'claude-opus-5-5', lifecycle: 'active', display_name: 'Claude Opus 5.5' },
        { id: 'claude-old', lifecycle: 'deprecated' },
      ], has_more: false, last_id: null }));
    }, async (baseUrl) => {
      await expect(listProviderModels({ provider: 'anthropic', baseUrl, apiKey: 'anthropic-list-secret' })).resolves.toEqual(['claude-opus-5-5']);
    });
  });

  it('normalizes Gemini resource names and uses the native list authentication', async () => {
    await withServer((request, response) => {
      expect(request.url).toBe('/v1beta/models?pageSize=1000');
      expect(request.headers['x-goog-api-key']).toBe('gemini-list-secret');
      expect(request.headers.authorization).toBeUndefined();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{ name: 'models/gemini-3.1-pro' }, { name: 'models/gemini-3-flash' }] }));
    }, async (baseUrl) => {
      await expect(listProviderModels({ provider: 'gemini', baseUrl: `${baseUrl}/v1beta/openai`, apiKey: 'gemini-list-secret' })).resolves.toEqual(['gemini-3.1-pro', 'gemini-3-flash']);
    });
  });

  it('paginates the Qwen workspace model-management endpoint', async () => {
    const pages: string[] = [];
    await withServer((request, response) => {
      const url = new URL(request.url ?? '', 'http://localhost');
      const page = Number(url.searchParams.get('page_no'));
      pages.push(String(page));
      expect(url.pathname).toBe('/api/v1/models');
      expect(url.searchParams.get('providers')).toBe('qwen');
      expect(url.searchParams.get('capabilities')).toBe('TG');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, output: {
        total: 2, models: [{ model: page === 1 ? 'qwen3.7-plus' : 'qwen3.8-max' }],
      } }));
    }, async (baseUrl) => {
      await expect(listProviderModels({ provider: 'qwen', baseUrl, modelListBaseUrl: baseUrl, apiKey: 'qwen-secret' })).resolves.toEqual(['qwen3.7-plus', 'qwen3.8-max']);
    });
    expect(pages).toEqual(['1', '2']);
  });

  it('does not invent an online model list for GLM', async () => {
    await caughtError(listProviderModels({ provider: 'zhipu', apiKey: 'secret' }), 'model_list_unsupported');
    await caughtError(listProviderModels({ provider: 'qwen', apiKey: 'secret' }), 'configuration_error');
  });

  it('rejects malformed responses and redacts credentials in HTTP errors', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ name: 'missing-id' }] }));
    }, async (baseUrl) => {
      await caughtError(listProviderModels({ provider: 'openai', baseUrl, apiKey: 'secret' }), 'invalid_response');
    });
    await withServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'bad list-secret' } }));
    }, async (baseUrl) => {
      const error = await caughtError(listProviderModels({ provider: 'deepseek', baseUrl, apiKey: 'list-secret' }), 'authentication');
      expect(error.message).not.toContain('list-secret');
      expect(error.message).toContain('[redacted]');
    });
  });
});
