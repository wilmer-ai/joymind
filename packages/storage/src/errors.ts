import { JoymindError } from '@joymind/core';

export function notFound(kind: string, id: string): never {
  throw new JoymindError({
    code: 'not_found',
    message: `${kind} not found: ${id}`,
    retryable: false,
    details: { kind, id },
  });
}

export function conflict(message: string, details?: Record<string, unknown>, cause?: unknown): never {
  const normalized = {
    code: 'conflict',
    message,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  };
  throw new JoymindError(normalized, cause === undefined ? undefined : { cause });
}
