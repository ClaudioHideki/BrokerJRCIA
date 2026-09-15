import { randomBytes, randomUUID } from 'node:crypto';

import {
  CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE,
  type AuthTokens,
  type ConsoleSessionResponse,
} from '@jrc/contracts';
import {
  createOpaqueToken,
  hashRefreshToken,
  issueAccessToken,
  verifyAccessToken,
  type RandomBytesSource,
} from '@jrc/security';

import { createAuditDigest } from '../audit/security-audit.js';
import { AuthServiceError, type WriteSecurityAudit } from './login.js';
import type { BrowserSessionRepository } from './repository.js';
import type { OrganizationSelectedAuditEvent, SelectOrganizationCommand } from './select-organization.js';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface BrowserSessionResult {
  response: ConsoleSessionResponse;
  refreshToken: string;
}

export interface SwitchBrowserOrganizationCommand {
  rawRefreshToken: string;
  authenticatedUserId: string;
  authenticatedOrganizationId: string;
  targetOrganizationId: string;
  requestId: string;
}

export interface BrowserSessionDependencies {
  repository: BrowserSessionRepository;
  jwtSecret: string;
  refreshTokenHashSecret: string;
  selectOrganization(command: SelectOrganizationCommand): Promise<AuthTokens>;
  refreshSession(rawToken: string, requestId: string): Promise<AuthTokens>;
  logout(rawToken: string, requestId: string): Promise<void>;
  writeSecurityAudit: WriteSecurityAudit;
  writeOrganizationSelectedAudit(event: OrganizationSelectedAuditEvent): Promise<void>;
  now?: () => Date;
  randomBytes?: RandomBytesSource;
  randomUuid?: () => string;
}

export class BrowserSessionPreservedError extends Error {
  readonly code = CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE;
  readonly statusCode = 409 as const;

  constructor() {
    super(CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE);
    this.name = 'BrowserSessionPreservedError';
  }
}

export class BrowserSessionSourceMismatchError extends AuthServiceError {
  constructor() {
    super('INVALID_SESSION', 401);
    this.name = 'BrowserSessionSourceMismatchError';
  }
}

export function createBrowserSessionService(dependencies: BrowserSessionDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const secureRandom = dependencies.randomBytes ?? randomBytes;
  const uuid = dependencies.randomUuid ?? randomUUID;

  async function project(tokens: AuthTokens, requestId: string): Promise<BrowserSessionResult> {
    try {
      const claims = await verifyAccessToken(tokens.accessToken, dependencies.jwtSecret, now());
      const identity = await dependencies.repository.findBrowserSessionIdentity(claims.sub);
      const activeOrganization = identity?.organizations.find(
        ({ id }) => id === claims.organization_id,
      );
      if (!identity || !activeOrganization || activeOrganization.role !== claims.role) {
        throw new AuthServiceError('INVALID_SESSION', 401);
      }
      return {
        refreshToken: tokens.refreshToken,
        response: {
          accessToken: tokens.accessToken,
          tokenType: tokens.tokenType,
          expiresIn: tokens.expiresIn,
          user: identity.user,
          activeOrganization,
          organizations: identity.organizations,
        },
      };
    } catch (error) {
      await dependencies.logout(tokens.refreshToken, requestId);
      if (error instanceof AuthServiceError) throw error;
      throw new AuthServiceError('INVALID_SESSION', 401);
    }
  }

  return {
    async select(command: SelectOrganizationCommand): Promise<BrowserSessionResult> {
      return project(await dependencies.selectOrganization(command), command.requestId);
    },

    async restore(rawRefreshToken: string, requestId: string): Promise<BrowserSessionResult> {
      return project(await dependencies.refreshSession(rawRefreshToken, requestId), requestId);
    },

    async switchOrganization(
      command: SwitchBrowserOrganizationCommand,
    ): Promise<BrowserSessionResult> {
      const issuedAt = now();
      const nextRefreshToken = createOpaqueToken(secureRandom);
      const currentTokenHash = hashRefreshToken(
        command.rawRefreshToken,
        dependencies.refreshTokenHashSecret,
      );
      const switched = await dependencies.repository.switchOrganization({
        currentTokenHash,
        expectedUserId: command.authenticatedUserId,
        expectedOrganizationId: command.authenticatedOrganizationId,
        targetOrganizationId: command.targetOrganizationId,
        nextTokenId: uuid(),
        nextFamilyId: uuid(),
        nextTokenHash: hashRefreshToken(nextRefreshToken, dependencies.refreshTokenHashSecret),
        nextExpiresAt: new Date(issuedAt.getTime() + REFRESH_TOKEN_TTL_MS),
        now: issuedAt,
      });
      const identityDigest = createAuditDigest(currentTokenHash);
      if (switched.outcome !== 'SWITCHED') {
        await dependencies.writeSecurityAudit({
          type: switched.outcome === 'REUSED' ? 'AUTH_REFRESH_REUSED' : 'AUTH_REFRESH_INVALID',
          requestId: command.requestId,
          identityDigest,
        });
        if (switched.outcome === 'PRESERVE_SOURCE') {
          throw new BrowserSessionPreservedError();
        }
        if (switched.outcome === 'SOURCE_MISMATCH') {
          throw new BrowserSessionSourceMismatchError();
        }
        throw new AuthServiceError('INVALID_SESSION', 401);
      }

      const accessToken = await issueAccessToken({
        userId: switched.userId,
        organizationId: switched.organizationId,
        role: switched.role,
      }, dependencies.jwtSecret, issuedAt);
      const result = await project({
        accessToken,
        refreshToken: nextRefreshToken,
        tokenType: 'Bearer',
        expiresIn: 600,
      }, command.requestId);
      await dependencies.writeSecurityAudit({
        type: 'AUTH_REFRESH_ROTATED',
        requestId: command.requestId,
        identityDigest,
      });
      await dependencies.writeOrganizationSelectedAudit({
        organizationId: switched.organizationId,
        actorId: switched.userId,
        resourceId: switched.organizationId,
        requestId: command.requestId,
      });
      return result;
    },

    async logout(rawRefreshToken: string, requestId: string): Promise<void> {
      await dependencies.logout(rawRefreshToken, requestId);
    },
  };
}
