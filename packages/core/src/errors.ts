import type { NormalizedError } from './types.js';

export class JoymindError extends Error {
  constructor(public readonly normalized: NormalizedError, options?: ErrorOptions) {
    super(normalized.message, options);
    this.name = 'JoymindError';
  }
}

export function normalizeError(error: unknown, fallback = 'internal_error'): NormalizedError {
  if (error instanceof JoymindError) return error.normalized;
  if (error instanceof Error && error.name === 'AbortError') return { code: 'cancelled', message: 'Operation cancelled', retryable: false };
  const message = error instanceof Error ? error.message : String(error);
  return { code: fallback, message, retryable: false };
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
