import { JoymindError } from '@joymind/core';
import type { NormalizedError } from '@joymind/core';

export interface ResilienceOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface ResolvedResilienceOptions {
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

export const defaultResilienceOptions: ResolvedResilienceOptions = {
  timeoutMs: 60_000,
  maxRetries: 2,
  retryDelayMs: 250,
};

export interface RequestControl {
  signal: AbortSignal;
  readonly timedOut: boolean;
  dispose(): void;
}

export function createRequestControl(signal: AbortSignal, timeoutMs: number): RequestControl {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal.reason);

  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Provider request timed out', 'TimeoutError'));
  }, timeoutMs);

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    },
  };
}

export function redactSecrets(message: string, secrets: readonly string[]): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

export function joymindError(
  code: string,
  message: string,
  retryable: boolean,
  secrets: readonly string[] = [],
  details?: Record<string, unknown>,
): JoymindError {
  const normalized: NormalizedError = {
    code,
    message: redactSecrets(message, secrets),
    retryable,
    ...(details ? { details } : {}),
  };
  return new JoymindError(normalized);
}

export function invalidStream(message: string, secrets: readonly string[] = []): JoymindError {
  return joymindError('invalid_stream', message, false, secrets);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseSseJson(data: string, provider: string, secrets: readonly string[]): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data);
    const record = asRecord(parsed);
    if (!record) throw new Error('Expected an object');
    return record;
  } catch {
    throw invalidStream(`${provider} returned invalid JSON in an SSE event`, secrets);
  }
}

export function parseToolArguments(source: string, provider: string, secrets: readonly string[]): unknown {
  if (source.trim() === '') return {};
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw invalidStream(`${provider} returned incomplete or invalid tool arguments`, secrets);
  }
}

export function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Operation cancelled', 'AbortError'));
  }
  if (delayMs <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Operation cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function httpErrorMessage(body: string, status: number, secrets: readonly string[]): string {
  let message = '';
  try {
    const parsed = asRecord(JSON.parse(body) as unknown);
    const error = asRecord(parsed?.error);
    const candidate = error?.message ?? parsed?.message;
    if (typeof candidate === 'string') message = candidate;
  } catch {
    message = body.trim();
  }
  const suffix = message ? `: ${message.slice(0, 500)}` : '';
  return redactSecrets(`Provider request failed with HTTP ${status}${suffix}`, secrets);
}

function errorForStatus(status: number, body: string, secrets: readonly string[]): JoymindError {
  const message = httpErrorMessage(body, status, secrets);
  const details = { status };
  if (status === 401 || status === 403) {
    return joymindError('authentication', message, false, secrets, details);
  }
  if (status === 429) return joymindError('rate_limited', message, true, secrets, details);
  if (status >= 500) return joymindError('provider_unavailable', message, true, secrets, details);
  return joymindError('provider_error', message, false, secrets, details);
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

export function normalizeProviderError(
  error: unknown,
  requestSignal: AbortSignal,
  control: RequestControl,
  secrets: readonly string[],
): JoymindError {
  if (error instanceof JoymindError) return error;
  if (requestSignal.aborted) return joymindError('cancelled', 'Provider request cancelled', false);
  if (control.timedOut) return joymindError('timeout', `Provider request timed out after ${control.signal.reason ? 'the configured deadline' : 'the deadline'}`, true);
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return joymindError('cancelled', 'Provider request cancelled', false);
  }
  const message = error instanceof Error ? error.message : String(error);
  return joymindError('network_error', `Provider network request failed: ${message}`, true, secrets);
}

export async function fetchWithRetries(
  url: string,
  init: RequestInit,
  options: ResolvedResilienceOptions,
  control: RequestControl,
  requestSignal: AbortSignal,
  secrets: readonly string[],
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    if (control.signal.aborted) {
      throw normalizeProviderError(new DOMException('Aborted', 'AbortError'), requestSignal, control, secrets);
    }

    let response: Response;
    try {
      response = await fetch(url, { ...init, redirect: 'manual', signal: control.signal });
    } catch (error) {
      if (control.signal.aborted) throw normalizeProviderError(error, requestSignal, control, secrets);
      if (attempt < options.maxRetries) {
        await waitFor(options.retryDelayMs * 2 ** attempt, control.signal);
        continue;
      }
      throw normalizeProviderError(error, requestSignal, control, secrets);
    }

    if (response.ok) return response;
    const body = await response.text();
    const error = errorForStatus(response.status, body, secrets);
    if (!shouldRetry(response.status) || attempt >= options.maxRetries) throw error;
    await waitFor(options.retryDelayMs * 2 ** attempt, control.signal);
  }
}
