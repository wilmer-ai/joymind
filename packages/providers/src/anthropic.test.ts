import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from './anthropic.js';
import { caughtError, collect, modelRequest, withServer, writeFragmented } from './test-server.js';

const secret = 'anthropic-test-secret';

function anthropicEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('AnthropicProvider', () => {
  it('uses the Messages protocol and joins input_json_delta tool arguments', async () => {
    await withServer((request, response, body) => {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v1/messages');
      expect(request.headers['x-api-key']).toBe(secret);
      expect(request.headers['anthropic-version']).toBe('2023-06-01');
      const payload = JSON.parse(body) as Record<string, unknown>;
      expect(payload).toMatchObject({ model: 'test-model', stream: true, max_tokens: 128 });
      expect(payload.tools).toEqual([{
        name: 'fs.read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }]);

      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const wire = [
        anthropicEvent('message_start', {
          type: 'message_start',
          message: { usage: { input_tokens: 13, output_tokens: 1 } },
        }),
        anthropicEvent('content_block_start', {
          type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
        }),
        anthropicEvent('content_block_delta', {
          type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' },
        }),
        anthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
        anthropicEvent('content_block_start', {
          type: 'content_block_start', index: 1,
          content_block: { type: 'tool_use', id: 'toolu-1', name: 'fs.read', input: {} },
        }),
        anthropicEvent('content_block_delta', {
          type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"' },
        }),
        anthropicEvent('content_block_delta', {
          type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'src","lines":' },
        }),
        anthropicEvent('content_block_delta', {
          type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '20}' },
        }),
        anthropicEvent('content_block_stop', { type: 'content_block_stop', index: 1 }),
        anthropicEvent('message_delta', {
          type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 },
        }),
        anthropicEvent('message_stop', { type: 'message_stop' }),
      ].join('');
      writeFragmented(response, wire, 11);
    }, async (baseUrl) => {
      const events = await collect(new AnthropicProvider({
        baseUrl,
        apiKey: secret,
        retryDelayMs: 0,
      }).stream(modelRequest()));
      expect(events).toEqual([
        { type: 'text_delta', text: 'Hello' },
        { type: 'usage', inputTokens: 13, outputTokens: 9 },
        {
          type: 'tool_call',
          call: { id: 'toolu-1', name: 'fs.read', arguments: { path: 'src', lines: 20 } },
        },
        { type: 'done', reason: 'tool_use' },
      ]);
    });
  });

  it('normalizes Anthropic authentication failures without leaking x-api-key', async () => {
    let attempts = 0;
    await withServer((_request, response) => {
      attempts += 1;
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `Invalid ${secret}` } }));
    }, async (baseUrl) => {
      const error = await caughtError(collect(new AnthropicProvider({
        baseUrl,
        apiKey: secret,
        retryDelayMs: 0,
      }).stream(modelRequest())), 'authentication');
      expect(attempts).toBe(1);
      expect(error.message).not.toContain(secret);
      expect(JSON.stringify(error.normalized)).not.toContain(secret);
    });
  });

  it('rejects a stream missing message_stop', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(anthropicEvent('message_delta', {
        type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 },
      }));
    }, async (baseUrl) => {
      await caughtError(collect(new AnthropicProvider({ baseUrl }).stream(modelRequest())), 'invalid_stream');
    });
  });

  it('does not forward x-api-key across a redirect', async () => {
    let redirectedRequestReceived = false;
    await withServer((_request, response) => {
      redirectedRequestReceived = true;
      response.writeHead(200).end();
    }, async (targetUrl) => {
      await withServer((_request, response) => {
        response.writeHead(302, { location: `${targetUrl}/v1/messages` }).end();
      }, async (baseUrl) => {
        await expect(collect(new AnthropicProvider({ baseUrl, apiKey: secret, maxRetries: 0 }).stream(modelRequest()))).rejects.toThrow();
      });
    });
    expect(redirectedRequestReceived).toBe(false);
  });
});
