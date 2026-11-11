import type {
  ModelCapabilities,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
} from '@joymind/core';
import { z } from 'zod';
import {
  asRecord,
  createRequestControl,
  defaultResilienceOptions,
  fetchWithRetries,
  invalidStream,
  normalizeProviderError,
  parseSseJson,
  parseToolArguments,
} from './shared.js';
import type { ResilienceOptions } from './shared.js';
import { parseSse } from './sse.js';

export const anthropicProviderConfigSchema = z.object({
  baseUrl: z.url().optional(),
  apiKey: z.string().min(1).optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  anthropicVersion: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  retryDelayMs: z.number().int().min(0).max(60_000).optional(),
}).strict();

export type AnthropicProviderConfig = z.infer<typeof anthropicProviderConfigSchema>;

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

function toolInput(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? { value };
}

function convertMessages(messages: ModelMessage[]): { system?: string; messages: Array<{ role: string; content: ContentBlock[] }> } {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const converted: Array<{ role: string; content: ContentBlock[] }> = [];

  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: ContentBlock[] = [];
    if (message.role === 'tool') {
      content.push({ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content });
    } else {
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: toolInput(call.arguments) });
      }
    }

    const previous = converted.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else converted.push({ role, content });
  }

  return { ...(system ? { system } : {}), messages: converted };
}

export class AnthropicProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly anthropicVersion: string;
  private readonly resilience: Required<ResilienceOptions>;
  private readonly secrets: string[];

  constructor(config: AnthropicProviderConfig = {}) {
    const parsed = anthropicProviderConfigSchema.parse(config);
    this.baseUrl = (parsed.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    if (parsed.apiKey) this.apiKey = parsed.apiKey;
    this.defaultHeaders = { ...parsed.defaultHeaders };
    this.anthropicVersion = parsed.anthropicVersion ?? '2023-06-01';
    this.resilience = {
      timeoutMs: parsed.timeoutMs ?? defaultResilienceOptions.timeoutMs,
      maxRetries: parsed.maxRetries ?? defaultResilienceOptions.maxRetries,
      retryDelayMs: parsed.retryDelayMs ?? defaultResilienceOptions.retryDelayMs,
    };
    this.secrets = [...Object.values(this.defaultHeaders), ...(this.apiKey ? [this.apiKey] : [])];
  }

  async capabilities(_model: string): Promise<ModelCapabilities> {
    return { streaming: true, toolCalling: true, structuredOutput: true, vision: false };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const control = createRequestControl(request.signal, this.resilience.timeoutMs);
    try {
      const headers: Record<string, string> = {
        ...this.defaultHeaders,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'anthropic-version': this.anthropicVersion,
      };
      if (this.apiKey) headers['x-api-key'] = this.apiKey;
      const converted = convertMessages(request.messages);

      const response = await fetchWithRetries(
        `${this.baseUrl}/v1/messages`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: request.model,
            ...converted,
            max_tokens: request.maxOutputTokens ?? 4096,
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
            stream: true,
          }),
        },
        this.resilience,
        control,
        request.signal,
        this.secrets,
      );
      if (!response.body) throw invalidStream('Anthropic response had no body', this.secrets);

      const toolCalls = new Map<number, ToolCallAccumulator>();
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let finishReason = 'end_turn';
      let receivedStop = false;

      for await (const event of parseSse(response.body)) {
        const message = parseSseJson(event.data, 'Anthropic', this.secrets);
        const type = message.type ?? event.event;

        if (type === 'message_start') {
          const start = asRecord(message.message);
          const usage = asRecord(start?.usage);
          if (typeof usage?.input_tokens === 'number') inputTokens = usage.input_tokens;
          if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens;
          continue;
        }
        if (type === 'content_block_start') {
          if (typeof message.index !== 'number') throw invalidStream('Anthropic content block had no index', this.secrets);
          const block = asRecord(message.content_block);
          if (block?.type === 'tool_use') {
            if (typeof block.id !== 'string' || typeof block.name !== 'string') {
              throw invalidStream('Anthropic tool block was incomplete', this.secrets);
            }
            const input = asRecord(block.input);
            toolCalls.set(message.index, {
              id: block.id,
              name: block.name,
              arguments: input && Object.keys(input).length > 0 ? JSON.stringify(input) : '',
            });
          }
          continue;
        }
        if (type === 'content_block_delta') {
          if (typeof message.index !== 'number') throw invalidStream('Anthropic content delta had no index', this.secrets);
          const delta = asRecord(message.delta);
          if (delta?.type === 'text_delta') {
            if (typeof delta.text !== 'string') throw invalidStream('Anthropic text delta was invalid', this.secrets);
            if (delta.text) yield { type: 'text_delta', text: delta.text };
          } else if (delta?.type === 'input_json_delta') {
            if (typeof delta.partial_json !== 'string') {
              throw invalidStream('Anthropic tool argument delta was invalid', this.secrets);
            }
            const call = toolCalls.get(message.index);
            if (!call) throw invalidStream('Anthropic tool delta arrived before its content block', this.secrets);
            call.arguments += delta.partial_json;
          }
          continue;
        }
        if (type === 'message_delta') {
          const delta = asRecord(message.delta);
          if (typeof delta?.stop_reason === 'string') finishReason = delta.stop_reason;
          const usage = asRecord(message.usage);
          if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens;
          if (typeof usage?.input_tokens === 'number') inputTokens = usage.input_tokens;
          continue;
        }
        if (type === 'message_stop') {
          receivedStop = true;
          break;
        }
        if (type === 'error') {
          const providerError = asRecord(message.error);
          const errorMessage = providerError?.message;
          throw invalidStream(`Anthropic sent an error${typeof errorMessage === 'string' ? `: ${errorMessage}` : ''}`, this.secrets);
        }
      }

      if (!receivedStop) throw invalidStream('Anthropic stream ended before message_stop', this.secrets);
      if (inputTokens !== undefined || outputTokens !== undefined) {
        yield { type: 'usage', inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
      }
      for (const [, call] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
        yield {
          type: 'tool_call',
          call: {
            id: call.id,
            name: call.name,
            arguments: parseToolArguments(call.arguments, 'Anthropic', this.secrets),
          },
        };
      }
      yield { type: 'done', reason: finishReason };
    } catch (error) {
      throw normalizeProviderError(error, request.signal, control, this.secrets);
    } finally {
      control.dispose();
    }
  }
}
