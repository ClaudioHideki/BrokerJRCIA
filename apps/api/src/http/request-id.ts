import { randomUUID } from 'node:crypto';

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function resolveRequestId(value: unknown): string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
    ? value.toLowerCase()
    : randomUUID();
}
