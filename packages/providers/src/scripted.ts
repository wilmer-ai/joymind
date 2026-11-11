import { JoymindError } from '@joymind/core';
import type {
  ModelCapabilities,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from '@joymind/core';
import { waitFor } from './shared.js';

export type ScriptedStep = (ModelEvent & { delayMs?: number }) | { type: 'delay'; delayMs: number };
export type ScriptedResponse = readonly ScriptedStep[] | {
  events: readonly ScriptedStep[];
  delayMs?: number;
};

export interface ScriptedProviderOptions {
  queue?: ScriptedResponse[];
  byRun?: Record<string, ScriptedResponse[]>;
  runId?: (request: ModelRequest) => string;
}

function responseEvents(response: ScriptedResponse): { events: readonly ScriptedStep[]; delayMs: number } {
  return 'events' in response
    ? { events: response.events, delayMs: response.delayMs ?? 0 }
    : { events: response, delayMs: 0 };
}

export class ScriptedProvider implements ModelProvider {
  private readonly queue: ScriptedResponse[];
  private readonly byRun?: Map<string, ScriptedResponse[]>;
  private readonly runId?: (request: ModelRequest) => string;

  constructor(options: ScriptedProviderOptions | ScriptedResponse[] = {}) {
    if (Array.isArray(options)) {
      this.queue = [...options];
      return;
    }
    const resolved = options;
    this.queue = [...(resolved.queue ?? [])];
    if (resolved.byRun) {
      this.byRun = new Map(Object.entries(resolved.byRun).map(([runId, responses]) => [runId, [...responses]]));
    }
    if (resolved.runId) this.runId = resolved.runId;
  }

  async capabilities(_model: string): Promise<ModelCapabilities> {
    return { streaming: true, toolCalling: true, structuredOutput: true, vision: false };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    try {
      let queue = this.queue;
      if (this.byRun) {
        const extendedRequest = request as ModelRequest & { runId?: unknown };
        const runId = this.runId?.(request) ?? extendedRequest.runId;
        if (typeof runId !== 'string') {
          throw new JoymindError({ code: 'invalid_script', message: 'A run ID is required for run-scoped scripts', retryable: false });
        }
        const runQueue = this.byRun.get(runId);
        if (!runQueue) {
          throw new JoymindError({ code: 'invalid_script', message: `No scripts configured for run ${runId}`, retryable: false });
        }
        queue = runQueue;
      }

      const response = queue.shift();
      if (!response) {
        throw new JoymindError({ code: 'script_exhausted', message: 'No scripted response remains', retryable: false });
      }
      const { events, delayMs } = responseEvents(response);
      await waitFor(delayMs, request.signal);

      for (const step of events) {
        await waitFor(step.delayMs ?? 0, request.signal);
        if (step.type === 'delay') continue;
        const { delayMs: _delayMs, ...event } = step;
        yield event;
      }
    } catch (error) {
      if (error instanceof JoymindError) throw error;
      if (request.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new JoymindError({ code: 'cancelled', message: 'Scripted response cancelled', retryable: false });
      }
      throw new JoymindError({
        code: 'script_error',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
    }
  }
}
