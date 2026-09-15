import { redactSensitive } from '@jrc/security';

export interface AuditQueryExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

declare const auditDigestBrand: unique symbol;

export type AuditDigest = string & Readonly<{
  [auditDigestBrand]: true;
}>;

const AUDIT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const INVALID_AUDIT_DIGEST_MESSAGE = 'Audit digest must be a lowercase SHA-256 hexadecimal HMAC';

export function createAuditDigest(value: string): AuditDigest {
  if (typeof value !== 'string' || !AUDIT_DIGEST_PATTERN.test(value)) {
    throw new Error(INVALID_AUDIT_DIGEST_MESSAGE);
  }
  return value as AuditDigest;
}

function optionalAuditDigest(value: AuditDigest | undefined): AuditDigest | null {
  return value === undefined ? null : createAuditDigest(value);
}

type SecurityAuditEventBase = Readonly<{
  requestId: string;
  identityDigest?: AuditDigest;
  ipDigest?: AuditDigest;
}>;

export type SecurityAuditEvent =
  | (SecurityAuditEventBase & Readonly<{ type: 'AUTH_LOGIN_ACCEPTED' }>)
  | (SecurityAuditEventBase & Readonly<{ type: 'AUTH_LOGIN_DENIED' }>)
  | (SecurityAuditEventBase & Readonly<{ type: 'AUTH_RATE_LIMITED' }>)
  | (SecurityAuditEventBase & Readonly<{ type: 'AUTH_RATE_LIMIT_RELEASED' }>)
  | (SecurityAuditEventBase & Readonly<{ type: 'AUTH_RATE_LIMIT_UNAVAILABLE' }>)
  | (SecurityAuditEventBase & Readonly<{
    type: 'AUTH_PROGRESSIVE_DELAY_APPLIED';
    delaySeconds: number;
  }>)
  | (SecurityAuditEventBase & Readonly<{ type: 'AUTH_SELECTION_TOKEN_INVALID' }>)
  | (SecurityAuditEventBase & Readonly<{ type: 'AUTH_SELECTION_TOKEN_REUSED' }>)
  | (SecurityAuditEventBase & Readonly<{ type: 'AUTH_REFRESH_INVALID' }>)
  | (SecurityAuditEventBase & Readonly<{ type: 'AUTH_REFRESH_REUSED' }>)
  | (SecurityAuditEventBase & Readonly<{ type: 'AUTH_REFRESH_ROTATED' }>)
  | (SecurityAuditEventBase & Readonly<{ type: 'AUTH_LOGOUT_COMPLETED' }>)
  | (SecurityAuditEventBase & Readonly<{ type: 'AUTH_LOGOUT_INVALID' }>)
  | Readonly<{ type: 'BOOTSTRAP_COMPLETED'; requestId: string }>;

export type TenantAuditEvent =
  | Readonly<{
    type: 'ORGANIZATION_SELECTED';
    organizationId: string;
    actorId: string;
    resourceId: string;
    requestId: string;
  }>
  | Readonly<{
    type: 'TENANT_CREATED';
    organizationId: string;
    resourceId: string;
    requestId: string;
  }>
  | (Readonly<{
    type: 'API_KEY_ISSUED' | 'API_KEY_REVOKED';
    organizationId: string;
    actorId: string | null;
    resourceId: string;
    requestId: string;
  }> & (
    | Readonly<{ actorKind?: 'USER' }>
    | Readonly<{ actorKind: 'API_KEY'; actorApiKeyId: string }>
  ))
  | Readonly<{
    type: 'MEMBERSHIP_CHANGED';
    organizationId: string;
    actorId: string;
    resourceId: string;
    requestId: string;
  }>
  | (Readonly<{
    type: 'INSTANCE_CREATED' | 'INSTANCE_CONNECTED' | 'INSTANCE_DISCONNECTED';
    organizationId: string;
    actorId: string | null;
    resourceId: string;
    requestId: string;
  }> & (
    | Readonly<{ actorKind?: 'USER' }>
    | Readonly<{ actorKind: 'API_KEY'; actorApiKeyId: string }>
  ))
  | (Readonly<{
    type: 'INSTANCE_CONNECT_FAILED' | 'INSTANCE_DISCONNECT_FAILED' | 'INSTANCE_STATUS_FAILED';
    organizationId: string;
    actorId: string | null;
    resourceId: string;
    requestId: string;
    canonicalErrorCode: string;
  }> & (
    | Readonly<{ actorKind?: 'USER' }>
    | Readonly<{ actorKind: 'API_KEY'; actorApiKeyId: string }>
  ))
  | (Readonly<{
    type: 'RECONCILIATION_COMPLETED';
    organizationId: string;
    actorId: string | null;
    resourceId: string;
    requestId: string;
  }> & (
    | Readonly<{ actorKind?: 'USER' | 'INTERNAL' }>
    | Readonly<{ actorKind: 'API_KEY'; actorApiKeyId: string }>
  ))
  | (Readonly<{
    type: 'CROSS_TENANT_ACCESS_DENIED';
    organizationId: string;
    actorId: string | null;
    resourceId: string;
    requestId: string;
  }> & (
    | Readonly<{ actorKind?: 'USER' }>
    | Readonly<{ actorKind: 'API_KEY'; actorApiKeyId: string }>
  ));

export interface SecurityAuditRecord {
  eventType: SecurityAuditEvent['type'];
  requestId: string;
  identityDigest: string | null;
  ipDigest: string | null;
  outcome: 'SUCCESS' | 'DENIED';
  metadata: Record<string, unknown>;
}

export interface TenantAuditRecord {
  organizationId: string;
  actorId: string | null;
  eventType: TenantAuditEvent['type'];
  resourceType: 'organization' | 'api_key' | 'membership' | 'instance' | 'reconciliation';
  resourceId: string | null;
  requestId: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILED';
  metadata: Record<string, unknown>;
}

function safeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized = redactSensitive(metadata);
  return sanitized !== null && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {};
}

export function toSecurityAuditRecord(event: SecurityAuditEvent): SecurityAuditRecord {
  switch (event.type) {
    case 'AUTH_LOGIN_ACCEPTED':
      return {
        eventType: event.type,
        requestId: event.requestId,
        identityDigest: optionalAuditDigest(event.identityDigest),
        ipDigest: optionalAuditDigest(event.ipDigest),
        outcome: 'SUCCESS',
        metadata: {},
      };
    case 'AUTH_LOGIN_DENIED':
    case 'AUTH_RATE_LIMITED':
    case 'AUTH_RATE_LIMIT_UNAVAILABLE':
    case 'AUTH_PROGRESSIVE_DELAY_APPLIED':
    case 'AUTH_SELECTION_TOKEN_INVALID':
    case 'AUTH_SELECTION_TOKEN_REUSED':
    case 'AUTH_REFRESH_INVALID':
    case 'AUTH_REFRESH_REUSED':
    case 'AUTH_LOGOUT_INVALID':
      return {
        eventType: event.type,
        requestId: event.requestId,
        identityDigest: optionalAuditDigest(event.identityDigest),
        ipDigest: optionalAuditDigest(event.ipDigest),
        outcome: 'DENIED',
        metadata: event.type === 'AUTH_PROGRESSIVE_DELAY_APPLIED'
          ? safeMetadata({ delaySeconds: event.delaySeconds })
          : {},
      };
    case 'AUTH_RATE_LIMIT_RELEASED':
    case 'AUTH_REFRESH_ROTATED':
    case 'AUTH_LOGOUT_COMPLETED':
      return {
        eventType: event.type,
        requestId: event.requestId,
        identityDigest: optionalAuditDigest(event.identityDigest),
        ipDigest: optionalAuditDigest(event.ipDigest),
        outcome: 'SUCCESS',
        metadata: {},
      };
    case 'BOOTSTRAP_COMPLETED':
      return {
        eventType: event.type,
        requestId: event.requestId,
        identityDigest: null,
        ipDigest: null,
        outcome: 'SUCCESS',
        metadata: {},
      };
  }
}

export function toTenantAuditRecord(event: TenantAuditEvent): TenantAuditRecord {
  switch (event.type) {
    case 'ORGANIZATION_SELECTED':
      return {
        organizationId: event.organizationId,
        actorId: event.actorId,
        eventType: event.type,
        resourceType: 'organization',
        resourceId: event.resourceId,
        requestId: event.requestId,
        outcome: 'SUCCESS',
        metadata: {},
      };
    case 'TENANT_CREATED':
      return {
        organizationId: event.organizationId,
        actorId: null,
        eventType: event.type,
        resourceType: 'organization',
        resourceId: event.resourceId,
        requestId: event.requestId,
        outcome: 'SUCCESS',
        metadata: safeMetadata({ actorKind: 'LOCAL_ADMIN_COMMAND' }),
      };
    case 'API_KEY_ISSUED':
    case 'API_KEY_REVOKED':
      return {
        organizationId: event.organizationId,
        actorId: event.actorId,
        eventType: event.type,
        resourceType: 'api_key',
        resourceId: event.resourceId,
        requestId: event.requestId,
        outcome: 'SUCCESS',
        metadata: event.actorKind === 'API_KEY'
          ? safeMetadata({ actorKind: event.actorKind, actorApiKeyId: event.actorApiKeyId })
          : {},
      };
    case 'MEMBERSHIP_CHANGED':
      return {
        organizationId: event.organizationId,
        actorId: event.actorId,
        eventType: event.type,
        resourceType: 'membership',
        resourceId: event.resourceId,
        requestId: event.requestId,
        outcome: 'SUCCESS',
        metadata: {},
      };
    case 'INSTANCE_CREATED':
    case 'INSTANCE_CONNECTED':
    case 'INSTANCE_DISCONNECTED':
      return {
        organizationId: event.organizationId,
        actorId: event.actorId,
        eventType: event.type,
        resourceType: 'instance',
        resourceId: event.resourceId,
        requestId: event.requestId,
        outcome: 'SUCCESS',
        metadata: event.actorKind === 'API_KEY'
          ? safeMetadata({ actorKind: event.actorKind, actorApiKeyId: event.actorApiKeyId })
          : {},
      };
    case 'INSTANCE_CONNECT_FAILED':
    case 'INSTANCE_DISCONNECT_FAILED':
    case 'INSTANCE_STATUS_FAILED':
      return {
        organizationId: event.organizationId,
        actorId: event.actorId,
        eventType: event.type,
        resourceType: 'instance',
        resourceId: event.resourceId,
        requestId: event.requestId,
        outcome: 'FAILED',
        metadata: safeMetadata({
          canonicalErrorCode: event.canonicalErrorCode,
          ...(event.actorKind === 'API_KEY'
            ? { actorKind: event.actorKind, actorApiKeyId: event.actorApiKeyId }
            : {}),
        }),
      };
    case 'RECONCILIATION_COMPLETED':
      return {
        organizationId: event.organizationId,
        actorId: event.actorId,
        eventType: event.type,
        resourceType: 'reconciliation',
        resourceId: event.resourceId,
        requestId: event.requestId,
        outcome: 'SUCCESS',
        metadata: event.actorKind === 'API_KEY'
          ? safeMetadata({ actorKind: event.actorKind, actorApiKeyId: event.actorApiKeyId })
          : event.actorKind === 'INTERNAL'
            ? safeMetadata({ actorKind: event.actorKind })
            : {},
      };
    case 'CROSS_TENANT_ACCESS_DENIED':
      return {
        organizationId: event.organizationId,
        actorId: event.actorId,
        eventType: event.type,
        resourceType: 'organization',
        resourceId: event.resourceId,
        requestId: event.requestId,
        outcome: 'DENIED',
        metadata: event.actorKind === 'API_KEY'
          ? safeMetadata({ actorKind: event.actorKind, actorApiKeyId: event.actorApiKeyId })
          : {},
      };
  }
}
