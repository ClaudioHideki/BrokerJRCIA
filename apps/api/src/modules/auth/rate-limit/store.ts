export interface RateLimitDecision {
  allowed: boolean;
  count: number;
  remaining: number;
  retryAfterMs: number;
  released: boolean;
}

export type RateLimitStoreKind = 'memory' | 'redis';

// Evidence of a real block remains for two additional rate windows so the
// first allowed request can emit a release event. The marker is TTL-bounded.
export const RELEASE_MARKER_TTL_MULTIPLIER = 3;

export function releaseMarkerTtlMs(ttlMs: number): number {
  return ttlMs * RELEASE_MARKER_TTL_MULTIPLIER;
}

export interface RateLimitStore {
  readonly kind: RateLimitStoreKind;
  consume(key: string, limit: number, ttlMs: number): Promise<RateLimitDecision>;
}

const SAFE_RATE_LIMIT_KEY = /^(?:ip|identity):[a-f0-9]{64}$/;

export function assertSafeRateLimitKey(key: string): void {
  if (!SAFE_RATE_LIMIT_KEY.test(key)) {
    throw new Error('Rate-limit key must contain only a scoped HMAC digest');
  }
}

export function assertRateLimitArguments(limit: number, ttlMs: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('Rate-limit limit and TTL must be positive integers');
  }
}
