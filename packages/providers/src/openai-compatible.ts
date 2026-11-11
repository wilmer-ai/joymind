import type {
  ModelCapabilities,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelToolCall,
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

export const openAICompatibleProviderConfigSchema = z.object({
  baseUrl: z.url().optional(),
  apiKey: z.string().min(1).optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  retryDelayMs: z.number().int().min(0).max(60_000).optional(),
}).strict();

export type OpenAICompatibleProviderConfig = z.infer<typeof openAICompatibleProviderConfigSchema>;

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

function convertMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call: ModelToolCall) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly resilience: Required<ResilienceOptions>;
  private readonly secrets: string[];

  constructor(config: OpenAICompatibleProviderConfig = {}) {
    const parsed = openAICompatibleProviderConfigSchema.parse(config);
    this.baseUrl = (parsed.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    if (parsed.apiKey) this.apiKey = parsed.apiKey;
    this.defaultHeaders = { ...parsed.defaultHeaders };
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
      };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

      const response = await fetchWithRetries(
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: request.model,
            messages: request.messages.map(convertMessage),
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
            stream: true,
            stream_options: { include_usage: true },
            ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
          }),
        },
        this.resilience,
        control,
        request.signal,
        this.secrets,
      );
      if (!response.body) throw invalidStream('OpenAI-compatible response had no body', this.secrets);

      const toolCalls = new Map<number, ToolCallAccumulator>();
      let finishReason: string | undefined;
      let receivedDone = false;

      for await (const event of parseSse(response.body)) {
        if (event.data === '[DONE]') {
          receivedDone = true;
          break;
        }
        const chunk = parseSseJson(event.data, 'OpenAI-compatible provider', this.secrets);
        if (chunk.error) {
          const providerError = asRecord(chunk.error);
          const message = providerError?.message;
          throw invalidStream(
            `OpenAI-compatible provider sent an error${typeof message === 'string' ? `: ${message}` : ''}`,
            this.secrets,
          );
        }

        const usage = asRecord(chunk.usage);
        if (usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
          yield { type: 'usage', inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
        }
        if (!Array.isArray(chunk.choices)) {
          throw invalidStream('OpenAI-compatible SSE chunk had no choices array', this.secrets);
        }

        for (const choiceValue of chunk.choices) {
          const choice = asRecord(choiceValue);
          if (!choice) throw invalidStream('OpenAI-compatible SSE choice was invalid', this.secrets);
          if (typeof choice.index === 'number' && choice.index !== 0) continue;
          if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
          const delta = asRecord(choice.delta);
          if (!delta) throw invalidStream('OpenAI-compatible SSE choice had no delta', this.secrets);

          if (delta.content !== undefined && delta.content !== null) {
            if (typeof delta.content !== 'string') {
              throw invalidStream('OpenAI-compatible text delta was not a string', this.secrets);
            }
            if (delta.content) yield { type: 'text_delta', text: delta.content };
          }

          if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
            if (!Array.isArray(delta.tool_calls)) {
              throw invalidStream('OpenAI-compatible tool_calls delta was not an array', this.secrets);
            }
            for (const callValue of delta.tool_calls) {
              const call = asRecord(callValue);
              if (!call || typeof call.index !== 'number') {
                throw invalidStream('OpenAI-compatible tool call delta had no numeric index', this.secrets);
              }
              const current = toolCalls.get(call.index) ?? { id: '', name: '', arguments: '' };
              if (call.id !== undefined) {
                if (typeof call.id !== 'string') throw invalidStream('OpenAI-compatible tool call ID was invalid', this.secrets);
                if (current.id && call.id !== current.id) {
                  throw invalidStream('OpenAI-compatible tool call ID changed mid-stream', this.secrets);
                }
                current.id = call.id;
              }
              const functionDelta = asRecord(call.function);
              if (call.function !== undefined && !functionDelta) {
                throw invalidStream('OpenAI-compatible tool function delta was invalid', this.secrets);
              }
              if (functionDelta?.name !== undefined) {
                if (typeof functionDelta.name !== 'string') {
                  throw invalidStream('OpenAI-compatible tool name delta was invalid', this.secrets);
                }
                current.name += functionDelta.name;
              }
              if (functionDelta?.arguments !== undefined) {
                if (typeof functionDelta.arguments !== 'string') {
                  throw invalidStream('OpenAI-compatible tool argument delta was invalid', this.secrets);
                }
                current.arguments += functionDelta.arguments;
              }
              toolCalls.set(call.index, current);
            }
          }
        }
      }

      if (!receivedDone) {
        throw invalidStream('OpenAI-compatible stream ended before [DONE]', this.secrets);
      }
      for (const [index, call] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
        if (!call.id || !call.name) {
          throw invalidStream(`OpenAI-compatible tool call ${index} was incomplete`, this.secrets);
        }
        yield {
          type: 'tool_call',
          call: { id: call.id, name: call.name, arguments: parseToolArguments(call.arguments, 'OpenAI-compatible provider', this.secrets) },
        };
      }
      yield { type: 'done', reason: finishReason ?? 'stop' };
    } catch (error) {
      throw normalizeProviderError(error, request.signal, control, this.secrets);
    } finally {
      control.dispose();
    }
  }
}
