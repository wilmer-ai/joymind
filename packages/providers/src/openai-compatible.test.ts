import { describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import {
  caughtError,
  collect,
  modelRequest,
  openAiChunk,
  withServer,
  writeFragmented,
} from './test-server.js';

const secret = 'openai-test-secret';

function provider(baseUrl: string, options: { maxRetries?: number; timeoutMs?: number } = {}) {
  return new OpenAICompatibleProvider({
    baseUrl,
    apiKey: secret,
    defaultHeaders: { 'x-test-header': 'configured' },
    retryDelayMs: 0,
    ...options,
  });
}

describe('OpenAICompatibleProvider', () => {
  it('uses the HTTP protocol and joins fragmented text and tool arguments', async () => {
    await withServer((request, response, body) => {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/chat/completions');
      expect(request.headers.authorization).toBe(`Bearer ${secret}`);
      expect(request.headers['x-test-header']).toBe('configured');
      const payload = JSON.parse(body) as Record<string, unknown>;
      expect(payload).toMatchObject({ model: 'test-model', stream: true, max_tokens: 128 });
      expect(payload.stream_options).toEqual({ include_usage: true });
      expect(payload.tools).toEqual([{
        type: 'function',
        function: {
          name: 'fs.read',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      }]);

      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const wire = [
        openAiChunk({ content: '你好' }),
        openAiChunk({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'fs.', arguments: '{"path":"' } }] }),
        openAiChunk({ tool_calls: [{ index: 0, function: { name: 'read', arguments: 'src","flag":' } }] }),
        openAiChunk({ tool_calls: [{ index: 0, function: { arguments: 'true}' } }] }),
        openAiChunk({}, 'tool_calls'),
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      writeFragmented(response, wire);
    }, async (baseUrl) => {
      const events = await collect(provider(baseUrl).stream(modelRequest()));
      expect(events).toEqual([
        { type: 'text_delta', text: '你好' },
        { type: 'usage', inputTokens: 11, outputTokens: 7 },
        {
          type: 'tool_call',
          call: { id: 'call-1', name: 'fs.read', arguments: { path: 'src', flag: true } },
        },
        { type: 'done', reason: 'tool_calls' },
      ]);
    });
  });

  it('retries a 429 response a bounded number of times', async () => {
    let attempts = 0;
    await withServer((_request, response) => {
      attempts += 1;
      if (attempts === 1) {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'slow down' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: [DONE]\n\n');
    }, async (baseUrl) => {
      const events = await collect(provider(baseUrl).stream(modelRequest()));
      expect(events).toEqual([{ type: 'done', reason: 'stop' }]);
      expect(attempts).toBe(2);
    });
  });

  it('stops retrying a retryable failure at maxRetries', async () => {
    let attempts = 0;
    await withServer((_request, response) => {
      attempts += 1;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'unavailable' } }));
    }, async (baseUrl) => {
      const error = await caughtError(
        collect(provider(baseUrl, { maxRetries: 1 }).stream(modelRequest())),
        'provider_unavailable',
      );
      expect(error.normalized.retryable).toBe(true);
      expect(attempts).toBe(2);
    });
  });

  it('normalizes authentication errors without retrying or exposing the key', async () => {
    let attempts = 0;
    await withServer((_request, response) => {
      attempts += 1;
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `Rejected ${secret}` } }));
    }, async (baseUrl) => {
      const error = await caughtError(collect(provider(baseUrl).stream(modelRequest())), 'authentication');
      expect(error.normalized.retryable).toBe(false);
      expect(attempts).toBe(1);
      expect(error.message).toContain('[redacted]');
      expect(`${error.message}${error.stack}${JSON.stringify(error.normalized)}`).not.toContain(secret);
    });
  });

  it('rejects a disconnected stream instead of emitting done', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(openAiChunk({ content: 'partial' }));
    }, async (baseUrl) => {
      await caughtError(collect(provider(baseUrl).stream(modelRequest())), 'invalid_stream');
    });
  });

  it('rejects invalid fragmented tool JSON without emitting a tool call', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        openAiChunk({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'fs.read', arguments: '{"path":' } }] }),
        openAiChunk({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ].join(''));
    }, async (baseUrl) => {
      const error = await caughtError(collect(provider(baseUrl).stream(modelRequest())), 'invalid_stream');
      expect(error.message).toContain('tool arguments');
    });
  });

  it('propagates cancellation to an in-flight HTTP/SSE request', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(openAiChunk({ content: 'first' }));
      const timer = setTimeout(() => response.end('data: [DONE]\n\n'), 5_000);
      response.on('close', () => clearTimeout(timer));
    }, async (baseUrl) => {
      const controller = new AbortController();
      const iterator = provider(baseUrl).stream(modelRequest(controller.signal))[Symbol.asyncIterator]();
      expect(await iterator.next()).toEqual({ done: false, value: { type: 'text_delta', text: 'first' } });
      controller.abort();
      const error = await caughtError(iterator.next() as Promise<unknown>, 'cancelled');
      expect(error.normalized.retryable).toBe(false);
    });
  });

  it('times out a stalled request', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
    }, async (baseUrl) => {
      const error = await caughtError(
        collect(provider(baseUrl, { timeoutMs: 30, maxRetries: 0 }).stream(modelRequest())),
        'timeout',
      );
      expect(error.normalized.retryable).toBe(true);
    });
  });
});
