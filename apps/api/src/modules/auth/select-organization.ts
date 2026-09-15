import { randomBytes, randomUUID } from 'node:crypto';

import type { AuthTokens } from '@jrc/contracts';
import {
  createOpaqueToken,
  hashOpaqueToken,
  hashRefreshToken,
  issueAccessToken,
  type RandomBytesSource,
} from '@jrc/security';

import type { AuthRepository } from './repository.js';
import { AuthServiceError, type WriteSecurityAudit } from './login.js';
import { asyncSleep, calculateProgressiveDelayMs, type ProgressiveDelayOptions } from './delay.js';
import { createSelectionRateLimitKeys } from './rate-limit/keys.js';
import type { RateLimitStore } from './rate-limit/store.js';
import { createAuditDigest } from '../audit/security-audit.js';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface SelectOrganizationCommand {
  organizationId: string;
  selectionToken: string;
  requestId: string;
  ipAddress: string;
}

export interface OrganizationSelectedAuditEvent {
  organizationId: string;
  actorId: string;
  resourceId: string;
  requestId: string;
}

export interface SelectOrganizationDependencies {
  repository: AuthRepository;
  jwtSecret: string;
  refreshTokenHashSecret: string;
  rateLimitStore: RateLimitStore;
  ipRateLimitHmacSecret: string;
  identityRateLimitHmacSecret: string;
  writeSecurityAudit: WriteSecurityAudit;
  writeOrganizationSelectedAudit(event: OrganizationSelectedAuditEvent): Promise<void>;
  now?: () => Date;
  randomBytes?: RandomBytesSource;
  randomUuid?: () => string;
  rateLimit?: { limit: number; ttlMs: number };
  progressiveDelay?: ProgressiveDelayOptions;
  sleeper?: (delayMs: number) => Promise<void>;
}

export function createSelectOrganizationService(dependencies: SelectOrganizationDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.randomUuid ?? randomUUID;
  const secureRandom = dependencies.randomBytes ?? randomBytes;
  const rateLimit = dependencies.rateLimit ?? { limit: 10, ttlMs: 60_000 };
  const progressiveDelay = dependencies.progressiveDelay
    ?? { baseDelayMs: 100, maximumDelayMs: 2_000 };
  const sleeper = dependencies.sleeper ?? asyncSleep;

  return async function selectOrganization(command: SelectOrganizationCommand): Promise<AuthTokens> {
    const keys = createSelectionRateLimitKeys({
      selectionToken: command.selectionToken,
      ipAddress: command.ipAddress,
      ipSecret: dependencies.ipRateLimitHmacSecret,
      identitySecret: dependencies.identityRateLimitHmacSecret,
    });
    const auditDigests = {
      identityDigest: createAuditDigest(keys.identity.slice('identity:'.length)),
      ipDigest: createAuditDigest(keys.ip.slice('ip:'.length)),
    };
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
    const delayMs = calculateProgressiveDelayMs(
      Math.max(...decisions.map(({ count }) => count)),
      progressiveDelay,
    );
    if (delayMs > 0) {
      await dependencies.writeSecurityAudit({
        type: 'AUTH_PROGRESSIVE_DELAY_APPLIED',
        requestId: command.requestId,
        delaySeconds: delayMs / 1_000,
        ...auditDigests,
      });
      await sleeper(delayMs);
    }
    const issuedAt = now();
    const refreshToken = createOpaqueToken(secureRandom);
    const selected = await dependencies.repository.consumeSelection({
      selectionTokenHash: hashOpaqueToken(command.selectionToken),
      organizationId: command.organizationId,
      now: issuedAt,
      refreshTokenId: uuid(),
      refreshFamilyId: uuid(),
      refreshTokenHash: hashRefreshToken(refreshToken, dependencies.refreshTokenHashSecret),
      refreshExpiresAt: new Date(issuedAt.getTime() + REFRESH_TOKEN_TTL_MS),
    });
    if (selected.outcome !== 'SELECTED') {
      await dependencies.writeSecurityAudit({
        type: selected.outcome === 'REUSED'
          ? 'AUTH_SELECTION_TOKEN_REUSED'
          : 'AUTH_SELECTION_TOKEN_INVALID',
        requestId: command.requestId,
        ...auditDigests,
      });
      throw new AuthServiceError('INVALID_CREDENTIALS', 401);
    }

    const accessToken = await issueAccessToken({
      userId: selected.userId,
      organizationId: selected.organizationId,
      role: selected.role,
    }, dependencies.jwtSecret, issuedAt);
    await dependencies.writeOrganizationSelectedAudit({
      organizationId: selected.organizationId,
      actorId: selected.userId,
      resourceId: selected.organizationId,
      requestId: command.requestId,
    });
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: 600,
    };
  };
}
