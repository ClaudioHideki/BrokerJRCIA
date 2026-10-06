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
  // Serialize with new directory/session references before deciding whether the
  // identity may be deleted. A referenced identity is retained as a tombstone;
  // DISABLED revokes access while preserving assignment history and team rows.
  const target = await transaction.query(
    'SELECT user_id FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR UPDATE',
    [input.organizationId, input.userId],
  );
  if (!target.rowCount) return;
  const preserved = await transaction.query(
    `UPDATE memberships m SET status = 'DISABLED', updated_at = now()
      WHERE m.organization_id = $1 AND m.user_id = $2 AND (
        EXISTS (SELECT 1 FROM local_attendance_team_members t
          WHERE t.organization_id = m.organization_id AND t.user_id = m.user_id)
        OR EXISTS (SELECT 1 FROM attendance_sessions s
          WHERE s.organization_id = m.organization_id AND s.local_agent_id = m.user_id)
      )`,
    [input.organizationId, input.userId],
  );
  if (preserved.rowCount) return;
  await transaction.query(
    'DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2',
    [input.organizationId, input.userId],
  );
}
