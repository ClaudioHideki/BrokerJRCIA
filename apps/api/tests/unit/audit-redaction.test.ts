import { describe, expect, it } from 'vitest';

import { writeTenantAudit, type TenantAuditEvent } from '../../src/modules/audit/audit.js';
import {
  createSecurityAuditWriter,
  type AuditQueryExecutor,
  type SecurityAuditEvent,
} from '../../src/modules/audit/security-audit.js';
import { createAuditDigest } from '../../src/modules/audit/events.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';

const REQUEST_ID = '23ecaf44-d006-4f48-8922-6dbf4cbec483';
const ORGANIZATION_ID = 'b33cd9ee-3640-49d7-a871-c0346e8417c4';
const ACTOR_ID = '2d392b9c-8bc1-4d46-867c-b7daa0354bfd';
const RESOURCE_ID = '7dba73f9-00fc-44a0-b0ff-3c85b8ca7530';
const IDENTITY_DIGEST = createAuditDigest('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const IP_DIGEST = createAuditDigest('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

const canaries = {
  password: 'password-canary',
  jwt: 'jwt-canary',
  refreshToken: 'refresh-token-canary',
  selectionToken: 'selection-token-canary',
  apiKey: 'api-key-canary',
  qrCode: 'qr-code-canary',
  pairingCode: 'pairing-code-canary',
  phone: 'phone-canary',
  providerCredential: 'provider-credential-canary',
  providerKey: 'provider-key-canary',
  body: { upstreamBody: 'upstream-body-canary' },
  headers: { authorization: 'upstream-header-canary' },
};

function recordingExecutor() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const executor: AuditQueryExecutor = {
    async query(text, values = []) {
      calls.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  return { calls, executor };
}

function expectNoCanaries(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const canary of [
    canaries.password,
    canaries.jwt,
    canaries.refreshToken,
    canaries.selectionToken,
    canaries.apiKey,
    canaries.qrCode,
    canaries.pairingCode,
    canaries.phone,
    canaries.providerCredential,
    canaries.providerKey,
    canaries.body.upstreamBody,
    canaries.headers.authorization,
  ]) {
    expect(serialized).not.toContain(canary);
  }
}

function withCanaries<T extends object>(event: T): T {
  return { ...event, ...canaries };
}

const securityCases: Array<{ event: SecurityAuditEvent; values: unknown[] }> = [
  { event: { type: 'AUTH_LOGIN_ACCEPTED', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST, ipDigest: IP_DIGEST }, values: ['AUTH_LOGIN_ACCEPTED', REQUEST_ID, IDENTITY_DIGEST, IP_DIGEST, 'SUCCESS', {}] },
  { event: { type: 'AUTH_LOGIN_DENIED', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST, ipDigest: IP_DIGEST }, values: ['AUTH_LOGIN_DENIED', REQUEST_ID, IDENTITY_DIGEST, IP_DIGEST, 'DENIED', {}] },
  { event: { type: 'AUTH_RATE_LIMITED', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST, ipDigest: IP_DIGEST }, values: ['AUTH_RATE_LIMITED', REQUEST_ID, IDENTITY_DIGEST, IP_DIGEST, 'DENIED', {}] },
  { event: { type: 'AUTH_RATE_LIMIT_RELEASED', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST, ipDigest: IP_DIGEST }, values: ['AUTH_RATE_LIMIT_RELEASED', REQUEST_ID, IDENTITY_DIGEST, IP_DIGEST, 'SUCCESS', {}] },
  { event: { type: 'AUTH_RATE_LIMIT_UNAVAILABLE', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST, ipDigest: IP_DIGEST }, values: ['AUTH_RATE_LIMIT_UNAVAILABLE', REQUEST_ID, IDENTITY_DIGEST, IP_DIGEST, 'DENIED', {}] },
  { event: { type: 'AUTH_PROGRESSIVE_DELAY_APPLIED', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST, ipDigest: IP_DIGEST, delaySeconds: 15 }, values: ['AUTH_PROGRESSIVE_DELAY_APPLIED', REQUEST_ID, IDENTITY_DIGEST, IP_DIGEST, 'DENIED', { delaySeconds: 15 }] },
  { event: { type: 'AUTH_SELECTION_TOKEN_INVALID', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST, ipDigest: IP_DIGEST }, values: ['AUTH_SELECTION_TOKEN_INVALID', REQUEST_ID, IDENTITY_DIGEST, IP_DIGEST, 'DENIED', {}] },
  { event: { type: 'AUTH_SELECTION_TOKEN_REUSED', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST, ipDigest: IP_DIGEST }, values: ['AUTH_SELECTION_TOKEN_REUSED', REQUEST_ID, IDENTITY_DIGEST, IP_DIGEST, 'DENIED', {}] },
  { event: { type: 'AUTH_REFRESH_INVALID', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST, ipDigest: IP_DIGEST }, values: ['AUTH_REFRESH_INVALID', REQUEST_ID, IDENTITY_DIGEST, IP_DIGEST, 'DENIED', {}] },
  { event: { type: 'AUTH_REFRESH_REUSED', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST }, values: ['AUTH_REFRESH_REUSED', REQUEST_ID, IDENTITY_DIGEST, null, 'DENIED', {}] },
  { event: { type: 'AUTH_REFRESH_ROTATED', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST }, values: ['AUTH_REFRESH_ROTATED', REQUEST_ID, IDENTITY_DIGEST, null, 'SUCCESS', {}] },
  { event: { type: 'AUTH_LOGOUT_COMPLETED', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST }, values: ['AUTH_LOGOUT_COMPLETED', REQUEST_ID, IDENTITY_DIGEST, null, 'SUCCESS', {}] },
  { event: { type: 'AUTH_LOGOUT_INVALID', requestId: REQUEST_ID, identityDigest: IDENTITY_DIGEST }, values: ['AUTH_LOGOUT_INVALID', REQUEST_ID, IDENTITY_DIGEST, null, 'DENIED', {}] },
  { event: { type: 'BOOTSTRAP_COMPLETED', requestId: REQUEST_ID }, values: ['BOOTSTRAP_COMPLETED', REQUEST_ID, null, null, 'SUCCESS', {}] },
];

const tenantCases: Array<{ event: TenantAuditEvent; values: unknown[] }> = [
  { event: { type: 'ORGANIZATION_SELECTED', organizationId: ORGANIZATION_ID, actorId: ACTOR_ID, resourceId: RESOURCE_ID, requestId: REQUEST_ID }, values: [ORGANIZATION_ID, ACTOR_ID, 'ORGANIZATION_SELECTED', 'organization', RESOURCE_ID, REQUEST_ID, 'SUCCESS', {}] },
  { event: { type: 'TENANT_CREATED', organizationId: ORGANIZATION_ID, resourceId: ORGANIZATION_ID, requestId: REQUEST_ID }, values: [ORGANIZATION_ID, null, 'TENANT_CREATED', 'organization', ORGANIZATION_ID, REQUEST_ID, 'SUCCESS', { actorKind: 'LOCAL_ADMIN_COMMAND' }] },
  { event: { type: 'API_KEY_ISSUED', organizationId: ORGANIZATION_ID, actorId: ACTOR_ID, resourceId: RESOURCE_ID, requestId: REQUEST_ID }, values: [ORGANIZATION_ID, ACTOR_ID, 'API_KEY_ISSUED', 'api_key', RESOURCE_ID, REQUEST_ID, 'SUCCESS', {}] },
  { event: { type: 'API_KEY_REVOKED', organizationId: ORGANIZATION_ID, actorId: ACTOR_ID, resourceId: RESOURCE_ID, requestId: REQUEST_ID }, values: [ORGANIZATION_ID, ACTOR_ID, 'API_KEY_REVOKED', 'api_key', RESOURCE_ID, REQUEST_ID, 'SUCCESS', {}] },
  { event: { type: 'API_KEY_ISSUED', organizationId: ORGANIZATION_ID, actorId: null, actorKind: 'API_KEY', actorApiKeyId: ACTOR_ID, resourceId: RESOURCE_ID, requestId: REQUEST_ID }, values: [ORGANIZATION_ID, null, 'API_KEY_ISSUED', 'api_key', RESOURCE_ID, REQUEST_ID, 'SUCCESS', { actorKind: 'API_KEY', actorApiKeyId: ACTOR_ID }] },
  { event: { type: 'MEMBERSHIP_CHANGED', organizationId: ORGANIZATION_ID, actorId: ACTOR_ID, resourceId: RESOURCE_ID, requestId: REQUEST_ID }, values: [ORGANIZATION_ID, ACTOR_ID, 'MEMBERSHIP_CHANGED', 'membership', RESOURCE_ID, REQUEST_ID, 'SUCCESS', {}] },
  { event: { type: 'INSTANCE_CREATED', organizationId: ORGANIZATION_ID, actorId: ACTOR_ID, resourceId: RESOURCE_ID, requestId: REQUEST_ID }, values: [ORGANIZATION_ID, ACTOR_ID, 'INSTANCE_CREATED', 'instance', RESOURCE_ID, REQUEST_ID, 'SUCCESS', {}] },
  { event: { type: 'INSTANCE_CONNECTED', organizationId: ORGANIZATION_ID, actorId: ACTOR_ID, resourceId: RESOURCE_ID, requestId: REQUEST_ID }, values: [ORGANIZATION_ID, ACTOR_ID, 'INSTANCE_CONNECTED', 'instance', RESOURCE_ID, REQUEST_ID, 'SUCCESS', {}] },
  { event: { type: 'INSTANCE_DISCONNECTED', organizationId: ORGANIZATION_ID, actorId: ACTOR_ID, resourceId: RESOURCE_ID, requestId: REQUEST_ID }, values: [ORGANIZATION_ID, ACTOR_ID, 'INSTANCE_DISCONNECTED', 'instance', RESOURCE_ID, REQUEST_ID, 'SUCCESS', {}] },
  { event: { type: 'RECONCILIATION_COMPLETED', organizationId: ORGANIZATION_ID, actorId: ACTOR_ID, resourceId: RESOURCE_ID, requestId: REQUEST_ID }, values: [ORGANIZATION_ID, ACTOR_ID, 'RECONCILIATION_COMPLETED', 'reconciliation', RESOURCE_ID, REQUEST_ID, 'SUCCESS', {}] },
  { event: { type: 'CROSS_TENANT_ACCESS_DENIED', organizationId: ORGANIZATION_ID, actorId: ACTOR_ID, resourceId: RESOURCE_ID, requestId: REQUEST_ID }, values: [ORGANIZATION_ID, ACTOR_ID, 'CROSS_TENANT_ACCESS_DENIED', 'organization', RESOURCE_ID, REQUEST_ID, 'DENIED', {}] },
];

describe('audit event allowlists', () => {
  it.each([
    'owner@example.test',
    'Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ])('recusa digest que não seja HMAC SHA-256 hexadecimal minúsculo: %s', (value) => {
    expect(() => createAuditDigest(value)).toThrow('Audit digest must be a lowercase SHA-256 hexadecimal HMAC');
  });

  it('recusa identidade em texto aberto antes de emitir SQL', async () => {
    const { calls, executor } = recordingExecutor();
    const writeSecurityAudit = createSecurityAuditWriter(executor);

    await expect(writeSecurityAudit({
      type: 'AUTH_LOGIN_DENIED',
      requestId: REQUEST_ID,
      identityDigest: 'owner@example.test',
      ipDigest: IP_DIGEST,
    } as unknown as SecurityAuditEvent)).rejects.toThrow('Audit digest must be a lowercase SHA-256 hexadecimal HMAC');

    expect(calls).toEqual([]);
  });

  it('recusa IP em texto aberto antes de emitir SQL', async () => {
    const { calls, executor } = recordingExecutor();
    const writeSecurityAudit = createSecurityAuditWriter(executor);

    await expect(writeSecurityAudit({
      type: 'AUTH_LOGIN_DENIED',
      requestId: REQUEST_ID,
      identityDigest: IDENTITY_DIGEST,
      ipDigest: '203.0.113.25',
    } as unknown as SecurityAuditEvent)).rejects.toThrow('Audit digest must be a lowercase SHA-256 hexadecimal HMAC');

    expect(calls).toEqual([]);
  });

  it('recusa objeto coercível que carrega segredo antes de emitir SQL', async () => {
    const { calls, executor } = recordingExecutor();
    const writeSecurityAudit = createSecurityAuditWriter(executor);
    const coercibleDigest = {
      secret: 'coercible-digest-secret-canary',
      toString: () => 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    };

    await expect(writeSecurityAudit({
      type: 'AUTH_LOGIN_DENIED',
      requestId: REQUEST_ID,
      identityDigest: coercibleDigest,
      ipDigest: IP_DIGEST,
    } as unknown as SecurityAuditEvent)).rejects.toThrow('Audit digest must be a lowercase SHA-256 hexadecimal HMAC');

    expect(calls).toEqual([]);
  });

  it.each(securityCases)('persiste %s somente em security_audit_logs com a allowlist canônica', async ({ event, values }) => {
    const { calls, executor } = recordingExecutor();

    await createSecurityAuditWriter(executor)(withCanaries(event));

    expectNoCanaries(calls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/\bINSERT INTO security_audit_logs\b/);
    expect(calls[0]?.text).not.toMatch(/\bINSERT INTO audit_logs\b/);
    expect(calls[0]?.values).toEqual(values);
  });

  it.each(tenantCases)('persiste %s somente em audit_logs com a allowlist canônica', async ({ event, values }) => {
    const { calls, executor } = recordingExecutor();

    await writeTenantAudit(executor as unknown as TenantTransaction, withCanaries(event));

    expectNoCanaries(calls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/\bINSERT INTO audit_logs\b/);
    expect(calls[0]?.text).not.toContain('security_audit_logs');
    expect(calls[0]?.values).toEqual(values);
  });
});
