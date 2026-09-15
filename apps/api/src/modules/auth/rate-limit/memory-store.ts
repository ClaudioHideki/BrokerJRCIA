import {
  assertRateLimitArguments,
  assertSafeRateLimitKey,
  releaseMarkerTtlMs,
  type RateLimitDecision,
  type RateLimitStore,
} from './store.js';

interface MemoryWindow {
  count: number;
  expiresAtMs: number;
}

export interface MemoryRateLimitStoreOptions {
  now?: () => number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  readonly kind = 'memory' as const;
  readonly #entries = new Map<string, MemoryWindow>();
  readonly #blockedMarkers = new Map<string, number>();
  readonly #now: () => number;

  constructor(options: MemoryRateLimitStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  async consume(key: string, limit: number, ttlMs: number): Promise<RateLimitDecision> {
    assertSafeRateLimitKey(key);
    assertRateLimitArguments(limit, ttlMs);
    const now = this.#now();
    const existing = this.#entries.get(key);
    const blockedMarkerExpiresAt = this.#blockedMarkers.get(key);
    if (blockedMarkerExpiresAt !== undefined && blockedMarkerExpiresAt <= now) {
      this.#blockedMarkers.delete(key);
    }
    const beginsNewWindow = !existing || existing.expiresAtMs <= now;
    const window = !existing || existing.expiresAtMs <= now
      ? { count: 0, expiresAtMs: now + ttlMs }
      : existing;
    window.count += 1;
    this.#entries.set(key, window);
    const allowed = window.count <= limit;
    const released = allowed && beginsNewWindow && this.#blockedMarkers.delete(key);
    if (!allowed) {
      this.#blockedMarkers.set(key, now + releaseMarkerTtlMs(ttlMs));
    }

    return {
      allowed,
      count: window.count,
      remaining: Math.max(0, limit - window.count),
      retryAfterMs: Math.max(1, window.expiresAtMs - now),
      released,
    };
  }
}

export function assertRuntimeRateLimitStore(
  store: RateLimitStore,
  nodeEnvironment: 'development' | 'test' | 'production',
): void {
  if (store.kind === 'memory' && nodeEnvironment !== 'test') {
    throw new Error('MemoryRateLimitStore is restricted to tests');
  }
}
