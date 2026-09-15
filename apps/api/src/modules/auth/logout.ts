import { randomUUID } from 'node:crypto';

import { hashRefreshToken } from '@jrc/security';

import { createAuditDigest } from '../audit/security-audit.js';
import type { WriteSecurityAudit } from './login.js';
import type { AuthSessionRepository } from './repository.js';

export interface LogoutDependencies {
  repository: AuthSessionRepository;
  refreshTokenHashSecret: string;
  writeSecurityAudit: WriteSecurityAudit;
  now?: () => Date;
}

export function createLogoutService(dependencies: LogoutDependencies) {
  const now = dependencies.now ?? (() => new Date());

  return async function logout(rawToken: string, requestId: string = randomUUID()): Promise<void> {
    const tokenHash = hashRefreshToken(rawToken, dependencies.refreshTokenHashSecret);
    const result = await dependencies.repository.revokeRefreshFamily({
      tokenHash,
      now: now(),
    });
    await dependencies.writeSecurityAudit({
      type: result.outcome === 'INVALID' ? 'AUTH_LOGOUT_INVALID' : 'AUTH_LOGOUT_COMPLETED',
      requestId,
      identityDigest: createAuditDigest(tokenHash),
    });
  };
}
