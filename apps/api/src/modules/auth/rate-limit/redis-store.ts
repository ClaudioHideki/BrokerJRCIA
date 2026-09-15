import { createClient } from 'redis';

import {
  assertRateLimitArguments,
  assertSafeRateLimitKey,
  releaseMarkerTtlMs,
  type RateLimitDecision,
  type RateLimitStore,
} from './store.js';

export interface RedisEvalClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

export interface RuntimeRedisClientConfig {
  url: string;
  connectTimeoutMs: number;
  reconnectMaxAttempts: number;
  reconnectDelayMs: number;
}

export interface RuntimeRedisClientOptions {
  url: string;
  disableOfflineQueue: true;
  socket: {
    connectTimeout: number;
    reconnectStrategy(retries: number): number | false;
  };
}

export function createRuntimeRedisClientOptions(
  config: RuntimeRedisClientConfig,
): RuntimeRedisClientOptions {
  return {
    url: config.url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: config.connectTimeoutMs,
      reconnectStrategy(retries) {
        return retries >= config.reconnectMaxAttempts
          ? false
          : config.reconnectDelayMs;
      },
    },
  };
}

export function createRuntimeRedisClient(config: RuntimeRedisClientConfig) {
  return createClient(createRuntimeRedisClientOptions(config));
}

export class RateLimitStoreUnavailableError extends Error {
  constructor() {
    super('Rate-limit store temporarily unavailable');
    this.name = 'RateLimitStoreUnavailableError';
  }
}

const CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
local released = 0
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  released = redis.call('DEL', KEYS[2])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
if current > tonumber(ARGV[2]) then
  redis.call('PSETEX', KEYS[2], ARGV[3], '1')
end
return {current, ttl, released}
`;

export class RedisRateLimitStore implements RateLimitStore {
  readonly kind = 'redis' as const;
  readonly #client: RedisEvalClient;
  readonly #prefix: string;
  readonly #deadlineMs: number;

  constructor(client: RedisEvalClient, options: { prefix?: string; deadlineMs?: number } = {}) {
    this.#client = client;
    this.#prefix = options.prefix ?? 'jrc:auth:rate:';
    this.#deadlineMs = options.deadlineMs ?? 500;
    if (!Number.isSafeInteger(this.#deadlineMs) || this.#deadlineMs <= 0) {
      throw new Error('Redis rate-limit deadline must be a positive integer');
    }
  }

  async consume(key: string, limit: number, ttlMs: number): Promise<RateLimitDecision> {
    assertSafeRateLimitKey(key);
    assertRateLimitArguments(limit, ttlMs);
    let deadline: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.#client.eval(CONSUME_SCRIPT, {
          keys: [`${this.#prefix}${key}`, `${this.#prefix}${key}:blocked`],
          arguments: [String(ttlMs), String(limit), String(releaseMarkerTtlMs(ttlMs))],
        }),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new RateLimitStoreUnavailableError()), this.#deadlineMs);
          deadline.unref();
        }),
      ]);
      if (!Array.isArray(result) || result.length !== 3) {
        throw new RateLimitStoreUnavailableError();
      }
      const count = Number(result[0]);
      const retryAfterMs = Number(result[1]);
      const released = Number(result[2]);
      if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(retryAfterMs)) {
        throw new RateLimitStoreUnavailableError();
      }
      return {
        allowed: count <= limit,
        count,
        remaining: Math.max(0, limit - count),
        retryAfterMs: Math.max(1, retryAfterMs),
        released: released === 1,
      };
    } catch {
      throw new RateLimitStoreUnavailableError();
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  }
}
