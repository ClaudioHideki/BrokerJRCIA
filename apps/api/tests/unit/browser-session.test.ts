import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { issueAccessToken, verifyAccessToken } from '@jrc/security';

import { createBrowserSessionService } from '../../src/modules/auth/browser-session.js';
import type { BrowserSessionRepository } from '../../src/modules/auth/repository.js';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const USER_ID = '8e757fb4-18ff-4c20-841b-19f282ece546';
const SOURCE_ORGANIZATION_ID = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const TARGET_ORGANIZATION_ID = '2db58223-99c7-4f16-8b59-0fe73aa395a8';
const JWT_SECRET = 'jwt-secret-with-at-least-thirty-two-bytes';
const HASH_SECRET = 'refresh-hash-secret-with-at-least-32-bytes';
const RAW_REFRESH = 'r'.repeat(43);
const NEXT_REFRESH = 'n'.repeat(43);

const identity = {
  user: { id: USER_ID, email: 'owner@example.test' },
  organizations: [
    { id: SOURCE_ORGANIZATION_ID, name: 'Source', slug: 'source', role: 'OWNER' as const },
    { id: TARGET_ORGANIZATION_ID, name: 'Target', slug: 'target', role: 'VIEWER' as const },
  ],
};

function tokenHash(token: string): string {
  return createHmac('sha256', HASH_SECRET).update(token, 'utf8').digest('hex');
}

function harness(
  switchOutcome: 'SWITCHED' | 'INVALID' | 'REUSED' | 'PRESERVE_SOURCE' | 'SOURCE_MISMATCH' = 'SWITCHED',
) {
  const switches: unknown[] = [];
  const audits: unknown[] = [];
  const selected: unknown[] = [];
  const restored: unknown[] = [];
  const loggedOut: unknown[] = [];
  const repository: BrowserSessionRepository = {
    async findBrowserSessionIdentity() { return identity; },
    async switchOrganization(input) {
      switches.push(input);
      if (switchOutcome !== 'SWITCHED') return { outcome: switchOutcome };
      return {
        outcome: 'SWITCHED',
        userId: USER_ID,
        organizationId: TARGET_ORGANIZATION_ID,
        role: 'VIEWER',
      };
    },
  };
  const service = createBrowserSessionService({
    repository,
    jwtSecret: JWT_SECRET,
    refreshTokenHashSecret: HASH_SECRET,
    now: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, 6),
    randomUuid: () => '2f8eed7d-3f3f-4fa6-97c5-620b3780f9e7',
    async selectOrganization(command) {
      selected.push(command);
      return {
        accessToken: await issueAccessToken({
          userId: USER_ID,
          organizationId: SOURCE_ORGANIZATION_ID,
          role: 'OWNER',
        }, JWT_SECRET, NOW),
        refreshToken: RAW_REFRESH,
        tokenType: 'Bearer',
        expiresIn: 600,
      };
    },
    async refreshSession(rawToken, requestId) {
      restored.push({ rawToken, requestId });
      return {
        accessToken: await issueAccessToken({
          userId: USER_ID,
          organizationId: SOURCE_ORGANIZATION_ID,
          role: 'OWNER',
        }, JWT_SECRET, NOW),
        refreshToken: NEXT_REFRESH,
        tokenType: 'Bearer',
        expiresIn: 600,
      };
    },
    async logout(rawToken, requestId) { loggedOut.push({ rawToken, requestId }); },
    async writeSecurityAudit(event) { audits.push(event); },
    async writeOrganizationSelectedAudit() { return undefined; },
  });
  return { audits, loggedOut, restored, selected, service, switches };
}

describe('BrowserSessionService', () => {
  it('adapta seleção existente para resposta segura sem refresh', async () => {
    const subject = harness();

    const result = await subject.service.select({
      selectionToken: 's'.repeat(43),
      organizationId: SOURCE_ORGANIZATION_ID,
      requestId: '0e213691-faec-4abe-a3b6-439a6bedc80d',
      ipAddress: '127.0.0.1',
    });

    expect(result.refreshToken).toBe(RAW_REFRESH);
    expect(result.response).toEqual({
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      expiresIn: 600,
      user: identity.user,
      activeOrganization: identity.organizations[0],
      organizations: identity.organizations,
    });
    expect(result.response).not.toHaveProperty('refreshToken');
    expect(subject.selected).toHaveLength(1);
  });

  it('adapta restore existente e usa a organização retornada pela rotação', async () => {
    const subject = harness();

    const result = await subject.service.restore(RAW_REFRESH, '0e213691-faec-4abe-a3b6-439a6bedc80d');

    expect(result.refreshToken).toBe(NEXT_REFRESH);
    expect(result.response.activeOrganization).toEqual(identity.organizations[0]);
    expect(result.response).not.toHaveProperty('refreshToken');
    expect(subject.restored).toEqual([{
      rawToken: RAW_REFRESH,
      requestId: '0e213691-faec-4abe-a3b6-439a6bedc80d',
    }]);
  });

  it('troca atomicamente para família nova e emite JWT somente com role do alvo', async () => {
    const subject = harness();

    const result = await subject.service.switchOrganization({
      rawRefreshToken: RAW_REFRESH,
      authenticatedUserId: USER_ID,
      authenticatedOrganizationId: SOURCE_ORGANIZATION_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      requestId: '0e213691-faec-4abe-a3b6-439a6bedc80d',
    });

    expect(subject.switches).toEqual([{
      currentTokenHash: tokenHash(RAW_REFRESH),
      expectedUserId: USER_ID,
      expectedOrganizationId: SOURCE_ORGANIZATION_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      nextTokenId: '2f8eed7d-3f3f-4fa6-97c5-620b3780f9e7',
      nextFamilyId: '2f8eed7d-3f3f-4fa6-97c5-620b3780f9e7',
      nextTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      nextExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
      now: NOW,
    }]);
    expect(result.refreshToken).toHaveLength(43);
    expect(result.response.activeOrganization).toEqual(identity.organizations[1]);
    expect(result.response.activeOrganization.role).toBe('VIEWER');
    await expect(verifyAccessToken(result.response.accessToken, JWT_SECRET, NOW)).resolves.toMatchObject({
      sub: USER_ID,
      organization_id: TARGET_ORGANIZATION_ID,
      role: 'VIEWER',
    });
    expect(JSON.stringify({ audits: subject.audits, switches: subject.switches })).not.toContain(RAW_REFRESH);
  });

  it.each(['INVALID', 'REUSED'] as const)('não emite sessão quando o switch retorna %s', async (outcome) => {
    const subject = harness(outcome);

    await expect(subject.service.switchOrganization({
      rawRefreshToken: RAW_REFRESH,
      authenticatedUserId: USER_ID,
      authenticatedOrganizationId: SOURCE_ORGANIZATION_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      requestId: '0e213691-faec-4abe-a3b6-439a6bedc80d',
    })).rejects.toMatchObject({ code: 'INVALID_SESSION', statusCode: 401 });
  });

  it('distingue rejeição do destino quando a sessão fonte permanece válida', async () => {
    const subject = harness('PRESERVE_SOURCE');

    await expect(subject.service.switchOrganization({
      rawRefreshToken: RAW_REFRESH,
      authenticatedUserId: USER_ID,
      authenticatedOrganizationId: SOURCE_ORGANIZATION_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      requestId: '0e213691-faec-4abe-a3b6-439a6bedc80d',
    })).rejects.toMatchObject({
      code: 'ORGANIZATION_SWITCH_REJECTED',
      statusCode: 409,
    });
    expect(subject.restored).toEqual([]);
    expect(subject.loggedOut).toEqual([]);
  });

  it('mantém mismatch da fonte como sessão inválida restaurável', async () => {
    const subject = harness('SOURCE_MISMATCH');

    await expect(subject.service.switchOrganization({
      rawRefreshToken: RAW_REFRESH,
      authenticatedUserId: USER_ID,
      authenticatedOrganizationId: SOURCE_ORGANIZATION_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      requestId: '0e213691-faec-4abe-a3b6-439a6bedc80d',
    })).rejects.toMatchObject({ code: 'INVALID_SESSION', statusCode: 401 });
    expect(subject.loggedOut).toEqual([]);
  });

  it('reutiliza logout existente sem expor o cookie bruto', async () => {
    const subject = harness();

    await subject.service.logout(RAW_REFRESH, '0e213691-faec-4abe-a3b6-439a6bedc80d');

    expect(subject.loggedOut).toEqual([{
      rawToken: RAW_REFRESH,
      requestId: '0e213691-faec-4abe-a3b6-439a6bedc80d',
    }]);
  });
});
