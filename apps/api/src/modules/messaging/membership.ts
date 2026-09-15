import type { Pool } from 'pg';
import type { Role } from '../../http/plugins/authorization.js';

/** Revalidate the current membership; a previously issued JWT cannot preserve old privileges. */
export function createMessagingMembershipResolver(authPool: Pool) {
  return async (userId: string, organizationId: string): Promise<Role | null> => {
    const result = await authPool.query<{ role: Role }>(
      `SELECT m.role FROM memberships m
        JOIN users u ON u.id = m.user_id
        JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 AND m.organization_id = $2
         AND m.status = 'ACTIVE' AND u.status = 'ACTIVE' AND o.status = 'ACTIVE'`,
      [userId, organizationId],
    );
    return result.rows[0]?.role ?? null;
  };
}
