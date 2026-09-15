import type { TenantTransaction } from '../../db/tenant-transaction.js';

/** Database lookup on every operational boundary; cached JWT claims are insufficient. */
export async function isOrganizationActive(transaction: TenantTransaction, organizationId: string): Promise<boolean> {
  const result = await transaction.query<{ active: boolean }>(
    'SELECT tenant_is_active($1::uuid) AS active', [organizationId],
  );
  return result.rows[0]?.active === true;
}

export class TenantOperationalError extends Error {
  readonly status = 403;
  readonly code = 'ORGANIZATION_NOT_ACTIVE';
  constructor() { super('ORGANIZATION_NOT_ACTIVE'); }
}

/** Never expose raw database messages; only known constraints are public errors. */
export function tenantOperationalProblem(error: unknown, requestId: string) {
  const candidate = error as { code?: unknown; constraint?: unknown } | null;
  const constraints: Record<string, string> = {
    tenant_organization_active: 'ORGANIZATION_NOT_ACTIVE',
    tenant_instance_limit: 'INSTANCE_LIMIT_REACHED',
    tenant_user_limit: 'USER_LIMIT_REACHED',
    tenant_pending_limit: 'PENDING_MESSAGE_LIMIT_REACHED',
    tenant_daily_limit: 'DAILY_MESSAGE_LIMIT_REACHED',
  };
  const code = error instanceof TenantOperationalError ? error.code
    : candidate?.code === '23514' && typeof candidate.constraint === 'string'
      ? constraints[candidate.constraint] : undefined;
  if (!code) return null;
  return { type: 'about:blank', title: code === 'ORGANIZATION_NOT_ACTIVE' ? 'Organization is not active' : 'Organization limit reached',
    status: code === 'ORGANIZATION_NOT_ACTIVE' ? 403 : 409, code, requestId };
}

export async function requireActiveOrganization(transaction: TenantTransaction, organizationId: string): Promise<void> {
  if (!await isOrganizationActive(transaction, organizationId)) throw new TenantOperationalError();
}

export async function readOperationalLimits(transaction: TenantTransaction, organizationId: string) {
  const result = await transaction.query<{
    status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED'; maxInstances: number; maxUsers: number;
    messagesPerDay: number; maxPendingMessages: number; messagesAcceptedToday: number;
  }>(`SELECT organization.status, limits.max_instances AS "maxInstances",
       limits.max_users AS "maxUsers", limits.messages_per_day AS "messagesPerDay",
       limits.max_pending_messages AS "maxPendingMessages",
       COALESCE(usage.accepted_messages,0) AS "messagesAcceptedToday"
     FROM organization_limits limits JOIN organizations organization ON organization.id=limits.organization_id
     LEFT JOIN organization_message_usage usage ON usage.organization_id=limits.organization_id
       AND usage.usage_day=(statement_timestamp() AT TIME ZONE 'UTC')::date
     WHERE limits.organization_id=$1`, [organizationId]);
  return result.rows[0] ?? null;
}
