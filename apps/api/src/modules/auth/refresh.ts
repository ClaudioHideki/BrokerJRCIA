import { randomBytes, randomUUID } from 'node:crypto';

import type { AuthTokens } from '@jrc/contracts';
import {
  createOpaqueToken,
  hashRefreshToken,
  issueAccessToken,
  type RandomBytesSource,
} from '@jrc/security';

import { createAuditDigest } from '../audit/security-audit.js';
import { AuthServiceError, type WriteSecurityAudit } from './login.js';
import type { AuthSessionRepository } from './repository.js';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface RefreshSessionDependencies {
  repository: AuthSessionRepository;
  jwtSecret: string;
  refreshTokenHashSecret: string;
  writeSecurityAudit: WriteSecurityAudit;
  now?: () => Date;
  randomBytes?: RandomBytesSource;
  randomUuid?: () => string;
}

export function createRefreshSessionService(dependencies: RefreshSessionDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const secureRandom = dependencies.randomBytes ?? randomBytes;
  const uuid = dependencies.randomUuid ?? randomUUID;

  return async function refreshSession(rawToken: string, requestId: string = randomUUID()): Promise<AuthTokens> {
    const issuedAt = now();
    const nextRefreshToken = createOpaqueToken(secureRandom);
    const currentTokenHash = hashRefreshToken(rawToken, dependencies.refreshTokenHashSecret);
    const rotation = await dependencies.repository.rotateRefreshToken({
      currentTokenHash,
      nextTokenId: uuid(),
      nextTokenHash: hashRefreshToken(nextRefreshToken, dependencies.refreshTokenHashSecret),
      nextExpiresAt: new Date(issuedAt.getTime() + REFRESH_TOKEN_TTL_MS),
      now: issuedAt,
    });
    const identityDigest = createAuditDigest(currentTokenHash);

    if (rotation.outcome !== 'ROTATED') {
      await dependencies.writeSecurityAudit({
        type: rotation.outcome === 'REUSED' ? 'AUTH_REFRESH_REUSED' : 'AUTH_REFRESH_INVALID',
        requestId,
        identityDigest,
      });
      throw new AuthServiceError('INVALID_SESSION', 401);
    }

    const accessToken = await issueAccessToken({
      userId: rotation.userId,
      organizationId: rotation.organizationId,
      role: rotation.role,
    }, dependencies.jwtSecret, issuedAt);
    await dependencies.writeSecurityAudit({
      type: 'AUTH_REFRESH_ROTATED',
      requestId,
      identityDigest,
    });
    return {
      accessToken,
      refreshToken: nextRefreshToken,
      tokenType: 'Bearer',
      expiresIn: 600,
    };
  };
}
