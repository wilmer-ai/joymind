import { JoymindError } from '@joymind/core';
import { z } from 'zod';
import { getProviderDefinition } from './catalog.js';
import { providerConnectionConfigSchema } from './factory.js';
import type { ProviderConnectionConfig } from './factory.js';
import { createRequestControl, fetchWithRetries, normalizeProviderError } from './shared.js';

const openAiModelsSchema = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1).max(200) }).passthrough()).max(2000),
}).passthrough();

const anthropicModelsSchema = z.object({
  data: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    lifecycle: z.enum(['active', 'deprecated', 'retired']).optional(),
  }).passthrough()).max(1000),
  has_more: z.boolean(),
  last_id: z.string().nullable(),
}).passthrough();

const geminiModelsSchema = z.object({
  models: z.array(z.object({
    name: z.string().trim().min(1).max(240),
    supportedGenerationMethods: z.array(z.string()).optional(),
  }).passthrough()).max(1000),
  nextPageToken: z.string().max(2000).optional(),
}).passthrough();

const qwenModelsSchema = z.object({
  success: z.boolean().optional(),
  output: z.object({
    total: z.number().int().nonnegative(),
    models: z.array(z.object({ model: z.string().trim().min(1).max(200) }).passthrough()).max(1000),
  }).passthrough(),
}).passthrough();

function invalidResponse(): JoymindError {
  return new JoymindError({ code: 'invalid_response', message: 'Provider returned an invalid model list.', retryable: false });
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)].slice(0, 2000);
}

async function fetchJson(url: string, headers: Record<string, string>, secrets: string[], signal: AbortSignal): Promise<unknown> {
  const control = createRequestControl(signal, 20_000);
  try {
    const response = await fetchWithRetries(
      url,
      { method: 'GET', headers },
      { timeoutMs: 20_000, maxRetries: 0, retryDelayMs: 0 },
      control,
      signal,
      secrets,
    );
    try { return await response.json() as unknown; } catch { throw invalidResponse(); }
  } catch (error) {
    throw normalizeProviderError(error, signal, control, secrets);
  } finally {
    control.dispose();
  }
}

function parseOpenAiModels(body: unknown): string[] {
  const result = openAiModelsSchema.safeParse(body);
  if (!result.success) throw invalidResponse();
  return result.data.data.map((model) => model.id);
}

async function listAnthropicModels(baseUrl: string, headers: Record<string, string>, secrets: string[], signal: AbortSignal): Promise<string[]> {
  const models: string[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < 20 && models.length < 2000; page += 1) {
    const url = new URL(`${baseUrl}/v1/models`);
    url.searchParams.set('limit', '1000');
    url.searchParams.set('lifecycle', 'active');
    if (afterId) url.searchParams.set('after_id', afterId);
    const result = anthropicModelsSchema.safeParse(await fetchJson(url.toString(), headers, secrets, signal));
    if (!result.success) throw invalidResponse();
    models.push(...result.data.data.filter((model) => !model.lifecycle || model.lifecycle === 'active').map((model) => model.id));
    if (!result.data.has_more || !result.data.last_id) break;
    afterId = result.data.last_id;
  }
  return unique(models);
}

async function listGeminiModels(baseUrl: string, headers: Record<string, string>, secrets: string[], signal: AbortSignal): Promise<string[]> {
  const models: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20 && models.length < 2000; page += 1) {
    const url = new URL(`${baseUrl.replace(/\/openai$/, '')}/models`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const result = geminiModelsSchema.safeParse(await fetchJson(url.toString(), headers, secrets, signal));
    if (!result.success) throw invalidResponse();
    models.push(...result.data.models
      .filter((model) => !model.supportedGenerationMethods || model.supportedGenerationMethods.includes('generateContent'))
      .map((model) => model.name.replace(/^models\//, '')).filter(Boolean));
    if (!result.data.nextPageToken) break;
    pageToken = result.data.nextPageToken;
  }
  return unique(models);
}

async function listQwenModels(baseUrl: string, headers: Record<string, string>, secrets: string[], signal: AbortSignal): Promise<string[]> {
  const models: string[] = [];
  for (let page = 1; page <= 20 && models.length < 2000; page += 1) {
    const url = new URL(`${baseUrl}/api/v1/models`);
    url.searchParams.set('page_no', String(page));
    url.searchParams.set('page_size', '100');
    url.searchParams.set('providers', 'qwen');
    url.searchParams.set('capabilities', 'TG');
    const result = qwenModelsSchema.safeParse(await fetchJson(url.toString(), headers, secrets, signal));
    if (!result.success || result.data.success === false) throw invalidResponse();
    models.push(...result.data.output.models.map((model) => model.model));
    if (models.length >= result.data.output.total || result.data.output.models.length === 0) break;
  }
  return unique(models);
}

export async function listProviderModels(config: ProviderConnectionConfig): Promise<string[]> {
  const parsed = providerConnectionConfigSchema.parse(config);
  const definition = getProviderDefinition(parsed.provider);
  if (definition.id === 'scripted') return [...definition.models];
  if (definition.modelList === 'none') {
    throw new JoymindError({ code: 'model_list_unsupported', message: `${definition.name} has no documented model list API. Enter a model ID manually.`, retryable: false });
  }
  const baseUrl = (parsed.baseUrl ?? definition.defaultBaseUrl)?.replace(/\/+$/, '');
  if (!baseUrl) {
    throw new JoymindError({ code: 'configuration_error', message: `${definition.name} requires a base URL.`, retryable: false });
  }
  if (definition.modelList === 'qwen' && !parsed.modelListBaseUrl) {
    throw new JoymindError({ code: 'configuration_error', message: 'Qwen model discovery requires a workspace and region-specific model list base URL.', retryable: false });
  }

  const secrets = parsed.apiKey ? [parsed.apiKey] : [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Model list request timed out', 'TimeoutError')), 20_000);
  const headers: Record<string, string> = { accept: 'application/json' };
  try {
    if (definition.modelList === 'anthropic') {
      headers['anthropic-version'] = '2026-10-21';
      if (parsed.apiKey) headers.authorization = `Bearer ${parsed.apiKey}`;
      return await listAnthropicModels(baseUrl, headers, secrets, controller.signal);
    }
    if (definition.modelList === 'gemini') {
      if (parsed.apiKey) headers['x-goog-api-key'] = parsed.apiKey;
      return await listGeminiModels(baseUrl, headers, secrets, controller.signal);
    }
    if (parsed.apiKey) headers.authorization = `Bearer ${parsed.apiKey}`;
    if (definition.modelList === 'qwen') {
      return await listQwenModels(parsed.modelListBaseUrl!.replace(/\/+$/, ''), headers, secrets, controller.signal);
    }
    return unique(parseOpenAiModels(await fetchJson(`${baseUrl}/models`, headers, secrets, controller.signal)));
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof DOMException && controller.signal.reason.name === 'TimeoutError') {
      throw new JoymindError({ code: 'timeout', message: 'Model list request timed out after 20 seconds.', retryable: true });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
