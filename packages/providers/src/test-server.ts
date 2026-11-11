import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JoymindError } from '@joymind/core';
import type { ModelEvent, ModelRequest } from '@joymind/core';
import { expect } from 'vitest';

export type TestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
) => void | Promise<void>;

export async function withServer<T>(handler: TestHandler, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      Promise.resolve(handler(request, response, body)).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

export function modelRequest(signal = new AbortController().signal): ModelRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Read a file' }],
    tools: [{
      name: 'fs.read',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    }],
    maxOutputTokens: 128,
    signal,
  };
}

export async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

export async function caughtError(promise: Promise<unknown>, code: string): Promise<JoymindError> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(JoymindError);
  const normalized = (error as JoymindError).normalized;
  expect(normalized.code).toBe(code);
  return error as JoymindError;
}

export function writeFragmented(response: ServerResponse, wire: string, fragmentSize = 7): void {
  const bytes = Buffer.from(wire);
  for (let offset = 0; offset < bytes.length; offset += fragmentSize) {
    response.write(bytes.subarray(offset, offset + fragmentSize));
  }
  response.end();
}

export function openAiChunk(delta: Record<string, unknown>, finishReason?: string): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  })}\n\n`;
}
