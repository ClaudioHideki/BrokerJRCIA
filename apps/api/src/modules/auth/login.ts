import type { LoginOrganizations } from '@jrc/contracts';
import {
  createOpaqueToken,
  hashOpaqueToken,
  type PasswordVerifier,
  type RandomBytesSource,
} from '@jrc/security';

import { createAuditDigest, type SecurityAuditEvent } from '../audit/security-audit.js';
import { asyncSleep, calculateProgressiveDelayMs, type ProgressiveDelayOptions } from './delay.js';
import type { AuthRepository } from './repository.js';
import { createRateLimitKeys } from './rate-limit/keys.js';
import type { RateLimitStore } from './rate-limit/store.js';

const SELECTION_TOKEN_TTL_MS = 5 * 60 * 1_000;

export type WriteSecurityAudit = (event: SecurityAuditEvent) => Promise<void>;

export class AuthServiceError extends Error {
  constructor(
    readonly code: 'INVALID_CREDENTIALS' | 'INVALID_SESSION' | 'AUTH_RATE_LIMITED' | 'AUTH_TEMPORARILY_UNAVAILABLE',
    readonly statusCode: 401 | 429 | 503,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'AuthServiceError';
  }
}

export interface LoginCommand {
  email: string;
  password: string;
  ipAddress: string;
  requestId: string;
}

export interface LoginDependencies {
  repository: AuthRepository;
  passwordVerifier: PasswordVerifier;
  rateLimitStore: RateLimitStore;
  writeSecurityAudit: WriteSecurityAudit;
  ipRateLimitHmacSecret: string;
  identityRateLimitHmacSecret: string;
  rateLimit?: { limit: number; ttlMs: number };
  progressiveDelay?: ProgressiveDelayOptions;
  now?: () => Date;
  randomBytes?: RandomBytesSource;
  sleeper?: (delayMs: number) => Promise<void>;
}

function digests(keys: ReturnType<typeof createRateLimitKeys>) {
  return {
    identityDigest: createAuditDigest(keys.identity.slice('identity:'.length)),
    ipDigest: createAuditDigest(keys.ip.slice('ip:'.length)),
  };
}

export function createLoginService(dependencies: LoginDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const rateLimit = dependencies.rateLimit ?? { limit: 10, ttlMs: 60_000 };
  const progressiveDelay = dependencies.progressiveDelay
    ?? { baseDelayMs: 100, maximumDelayMs: 2_000 };
  const sleeper = dependencies.sleeper ?? asyncSleep;

  return async function login(command: LoginCommand): Promise<LoginOrganizations> {
    const normalizedEmail = command.email.trim().toLowerCase();
    const keys = createRateLimitKeys({
      email: normalizedEmail,
      ipAddress: command.ipAddress,
      ipSecret: dependencies.ipRateLimitHmacSecret,
      identitySecret: dependencies.identityRateLimitHmacSecret,
    });
    const auditDigests = digests(keys);
    let decisions;
    try {
      decisions = await Promise.all([
        dependencies.rateLimitStore.consume(keys.ip, rateLimit.limit, rateLimit.ttlMs),
        dependencies.rateLimitStore.consume(keys.identity, rateLimit.limit, rateLimit.ttlMs),
      ]);
    } catch {
      await dependencies.writeSecurityAudit({
        type: 'AUTH_RATE_LIMIT_UNAVAILABLE',
        requestId: command.requestId,
        ...auditDigests,
      });
      throw new AuthServiceError('AUTH_TEMPORARILY_UNAVAILABLE', 503, 1);
    }

    const blocked = decisions.find(({ allowed }) => !allowed);
    if (blocked) {
      await dependencies.writeSecurityAudit({
        type: 'AUTH_RATE_LIMITED',
        requestId: command.requestId,
        ...auditDigests,
      });
      throw new AuthServiceError(
        'AUTH_RATE_LIMITED',
        429,
        Math.max(1, Math.ceil(blocked.retryAfterMs / 1_000)),
      );
    }
    if (decisions.some(({ released }) => released)) {
      await dependencies.writeSecurityAudit({
        type: 'AUTH_RATE_LIMIT_RELEASED',
        requestId: command.requestId,
        ...auditDigests,
      });
    }

    const attemptCount = Math.max(...decisions.map(({ count }) => count));
    const delayMs = calculateProgressiveDelayMs(attemptCount, progressiveDelay);
    if (delayMs > 0) {
      await dependencies.writeSecurityAudit({
        type: 'AUTH_PROGRESSIVE_DELAY_APPLIED',
        requestId: command.requestId,
        delaySeconds: delayMs / 1_000,
        ...auditDigests,
      });
      await sleeper(delayMs);
    }

    const identity = await dependencies.repository.findLoginIdentity(normalizedEmail);
    const passwordMatches = await dependencies.passwordVerifier.verifyPasswordOrDummy(
      command.password,
      identity?.passwordHash ?? null,
    );
    if (
      !identity
      || identity.status !== 'ACTIVE'
      || !passwordMatches
      || identity.organizations.length === 0
    ) {
      await dependencies.writeSecurityAudit({
        type: 'AUTH_LOGIN_DENIED',
        requestId: command.requestId,
        ...auditDigests,
      });
      throw new AuthServiceError('INVALID_CREDENTIALS', 401);
    }

    const selectionToken = createOpaqueToken(dependencies.randomBytes);
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + SELECTION_TOKEN_TTL_MS);
    await dependencies.repository.createSelectionSession({
      userId: identity.id,
      tokenHash: hashOpaqueToken(selectionToken),
      expiresAt,
    });
    await dependencies.writeSecurityAudit({
      type: 'AUTH_LOGIN_ACCEPTED',
      requestId: command.requestId,
      ...auditDigests,
    });

    return {
      organizations: identity.organizations.map(({ id, name, slug, role }) => ({
        id,
        name,
        slug,
        role,
      })),
      selectionToken,
      expiresAt: expiresAt.toISOString(),
    };
  };
}
