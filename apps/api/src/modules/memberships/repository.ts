import type { PoolClient, QueryResultRow } from 'pg';

export interface MembershipTransaction {
  query: PoolClient['query'];
}

export type MembershipRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
export type MembershipStatus = 'ACTIVE' | 'DISABLED';

export interface Membership {
  organizationId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
}

export async function createMembership(
  transaction: MembershipTransaction,
  input: { organizationId: string; userId: string; role: MembershipRole },
): Promise<void> {
  await transaction.query(
    `INSERT INTO memberships (organization_id, user_id, role)
     VALUES ($1, $2, $3)`,
    [input.organizationId, input.userId, input.role],
  );
}

export async function createOwnerMembership(
  transaction: MembershipTransaction,
  input: { organizationId: string; userId: string },
): Promise<void> {
  await transaction.query(
    `INSERT INTO memberships (organization_id, user_id, role)
     VALUES ($1, $2, 'OWNER')`,
    [input.organizationId, input.userId],
  );
}

export async function findMembershipForUpdate(
  transaction: MembershipTransaction,
  organizationId: string,
  userId: string,
): Promise<Membership | null> {
  const result = await transaction.query<Membership & QueryResultRow>(
    `SELECT organization_id AS "organizationId", user_id AS "userId", role, status
       FROM memberships
      WHERE organization_id = $1 AND user_id = $2
      FOR UPDATE`,
    [organizationId, userId],
  );
  return result.rows[0] ?? null;
}

export async function countActiveOwners(
  transaction: MembershipTransaction,
  organizationId: string,
): Promise<number> {
  const result = await transaction.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM memberships
      WHERE organization_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'`,
    [organizationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Owner count query returned no row');
  }
  return row.count;
}

export async function setMembershipRole(
  transaction: MembershipTransaction,
  input: { organizationId: string; userId: string; role: MembershipRole },
): Promise<void> {
  await transaction.query(
    `UPDATE memberships
        SET role = $3, updated_at = now()
      WHERE organization_id = $1 AND user_id = $2`,
    [input.organizationId, input.userId, input.role],
  );
}

export async function removeMembership(
  transaction: MembershipTransaction,
  input: { organizationId: string; userId: string },
): Promise<void> {
  await transaction.query(
    'DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2',
    [input.organizationId, input.userId],
  );
}
