import type { Pool, PoolClient, QueryResultRow } from 'pg';

export type AuthRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

export interface LoginOrganization {
  id: string;
  name: string;
  slug: string;
  role: AuthRole;
}

export interface LoginIdentity {
  id: string;
  passwordHash: string;
  status: 'ACTIVE' | 'DISABLED';
  organizations: LoginOrganization[];
}

export interface CreateSelectionSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface ConsumeSelectionInput {
  selectionTokenHash: string;
  organizationId: string;
  now: Date;
  refreshTokenId: string;
  refreshFamilyId: string;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
}

export interface SelectedOrganization {
  outcome: 'SELECTED';
  userId: string;
  organizationId: string;
  role: AuthRole;
}

export type SelectionConsumption =
  | SelectedOrganization
  | Readonly<{ outcome: 'INVALID' | 'REUSED' }>;

export interface AuthRepository {
  findLoginIdentity(email: string): Promise<LoginIdentity | null>;
  createSelectionSession(input: CreateSelectionSessionInput): Promise<void>;
  consumeSelection(input: ConsumeSelectionInput): Promise<SelectionConsumption>;
}

export interface RotateRefreshTokenInput {
  currentTokenHash: string;
  nextTokenId: string;
  nextTokenHash: string;
  nextExpiresAt: Date;
  now: Date;
}

export type RefreshRotation =
  | Readonly<{
    outcome: 'ROTATED';
    userId: string;
    organizationId: string;
    role: AuthRole;
  }>
  | Readonly<{ outcome: 'INVALID' | 'REUSED' }>;

export interface RevokeRefreshFamilyInput {
  tokenHash: string;
  now: Date;
}

export type LogoutResult = Readonly<{
  outcome: 'REVOKED' | 'ALREADY_REVOKED' | 'INVALID';
}>;

export interface AuthSessionRepository {
  rotateRefreshToken(input: RotateRefreshTokenInput): Promise<RefreshRotation>;
  revokeRefreshFamily(input: RevokeRefreshFamilyInput): Promise<LogoutResult>;
}

export interface BrowserSessionIdentity {
  user: Readonly<{ id: string; email: string }>;
  organizations: LoginOrganization[];
}

export interface SwitchOrganizationInput {
  currentTokenHash: string;
  expectedUserId: string;
  expectedOrganizationId: string;
  targetOrganizationId: string;
  nextTokenId: string;
  nextFamilyId: string;
  nextTokenHash: string;
  nextExpiresAt: Date;
  now: Date;
}

export type OrganizationSwitch =
  | Readonly<{
    outcome: 'SWITCHED';
    userId: string;
    organizationId: string;
    role: AuthRole;
  }>
  | Readonly<{ outcome: 'INVALID' | 'REUSED' | 'PRESERVE_SOURCE' | 'SOURCE_MISMATCH' }>;

export interface BrowserSessionRepository {
  findBrowserSessionIdentity(userId: string): Promise<BrowserSessionIdentity | null>;
  switchOrganization(input: SwitchOrganizationInput): Promise<OrganizationSwitch>;
}

interface LoginRow extends QueryResultRow {
  userId: string;
  passwordHash: string;
  userStatus: LoginIdentity['status'];
  organizationId: string | null;
  organizationName: string | null;
  organizationSlug: string | null;
  role: AuthRole | null;
}

interface BrowserIdentityRow extends QueryResultRow {
  userId: string;
  email: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: AuthRole;
}

async function assertAuthRole(client: PoolClient): Promise<void> {
  const identity = await client.query<{ currentUser: string; sessionUser: string }>(
    'SELECT current_user AS "currentUser", session_user AS "sessionUser"',
  );
  if (
    identity.rows[0]?.currentUser !== 'jrc_auth'
    || identity.rows[0]?.sessionUser !== 'jrc_auth'
  ) {
    throw new Error('Authentication repository requires a direct jrc_auth session');
  }
}

interface RefreshFamilyRow extends QueryResultRow {
  organizationId: string;
  familyId: string;
}

async function findRefreshFamily(
  client: PoolClient,
  tokenHash: string,
): Promise<RefreshFamilyRow | null> {
  const result = await client.query<RefreshFamilyRow>(
    `SELECT organization_id AS "organizationId", family_id AS "familyId"
       FROM refresh_tokens
      WHERE token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

async function lockRefreshFamily(client: PoolClient, family: RefreshFamilyRow): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 1788436807))",
    [`${family.organizationId}:${family.familyId}`],
  );
}

export function createPostgresAuthRepository(
  pool: Pool,
): AuthRepository & AuthSessionRepository & BrowserSessionRepository {
  return {
    async findLoginIdentity(email) {
      const client = await pool.connect();
      try {
        await assertAuthRole(client);
        const result = await client.query<LoginRow>(
          `SELECT u.id AS "userId", u.password_hash AS "passwordHash",
                  u.status AS "userStatus", o.id AS "organizationId",
                  o.name AS "organizationName", o.slug AS "organizationSlug", m.role
             FROM users u
             LEFT JOIN memberships m
               ON m.user_id = u.id AND m.status = 'ACTIVE'
             LEFT JOIN organizations o
               ON o.id = m.organization_id AND o.status = 'ACTIVE'
            WHERE u.email = $1
            ORDER BY o.name, o.id`,
          [email],
        );
        const first = result.rows[0];
        if (!first) return null;
        return {
          id: first.userId,
          passwordHash: first.passwordHash,
          status: first.userStatus,
          organizations: result.rows.flatMap((row) => (
            row.organizationId && row.organizationName && row.organizationSlug && row.role
              ? [{
                  id: row.organizationId,
                  name: row.organizationName,
                  slug: row.organizationSlug,
                  role: row.role,
                }]
              : []
          )),
        };
      } finally {
        client.release();
      }
    },

    async createSelectionSession(input) {
      const client = await pool.connect();
      try {
        await assertAuthRole(client);
        await client.query(
          `INSERT INTO login_sessions (user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)`,
          [input.userId, input.tokenHash, input.expiresAt],
        );
      } finally {
        client.release();
      }
    },

    async findBrowserSessionIdentity(userId) {
      const client = await pool.connect();
      try {
        await assertAuthRole(client);
        const result = await client.query<BrowserIdentityRow>(
          `SELECT u.id AS "userId", u.email,
                  o.id AS "organizationId", o.name AS "organizationName",
                  o.slug AS "organizationSlug", m.role
             FROM users u
             JOIN memberships m
               ON m.user_id = u.id AND m.status = 'ACTIVE'
             JOIN organizations o
               ON o.id = m.organization_id AND o.status = 'ACTIVE'
            WHERE u.id = $1 AND u.status = 'ACTIVE'
            ORDER BY o.name, o.id`,
          [userId],
        );
        const first = result.rows[0];
        if (!first) return null;
        return {
          user: { id: first.userId, email: first.email },
          organizations: result.rows.map((row) => ({
            id: row.organizationId,
            name: row.organizationName,
            slug: row.organizationSlug,
            role: row.role,
          })),
        };
      } finally {
        client.release();
      }
    },

    async consumeSelection(input) {
      const client = await pool.connect();
      try {
        await assertAuthRole(client);
        const result = await client.query<QueryResultRow & {
          userId: string | null;
          organizationId: string | null;
          role: AuthRole | null;
          outcome: SelectionConsumption['outcome'];
        }>(
          `SELECT result_user_id AS "userId",
                  result_organization_id AS "organizationId",
                  result_role AS role,
                  result_outcome AS outcome
             FROM consume_login_selection($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.selectionTokenHash,
            input.organizationId,
            input.now,
            input.refreshTokenId,
            input.refreshFamilyId,
            input.refreshTokenHash,
            input.refreshExpiresAt,
          ],
        );
        const row = result.rows[0];
        if (!row || row.outcome === 'INVALID') {
          return { outcome: 'INVALID' };
        }
        if (row.outcome === 'REUSED') {
          return { outcome: 'REUSED' };
        }
        if (row.outcome !== 'SELECTED') {
          throw new Error('Authentication selection function returned an invalid outcome');
        }
        if (!row.userId || !row.organizationId || !row.role) {
          throw new Error('Authentication selection function returned an invalid result');
        }
        return {
          outcome: 'SELECTED',
          userId: row.userId,
          organizationId: row.organizationId,
          role: row.role,
        };
      } finally {
        client.release();
      }
    },

    async rotateRefreshToken(input) {
      const client = await pool.connect();
      let transactionOpen = false;
      let discardConnection = false;
      try {
        await assertAuthRole(client);
        await client.query('BEGIN');
        transactionOpen = true;
        const family = await findRefreshFamily(client, input.currentTokenHash);
        if (!family) {
          await client.query('COMMIT');
          transactionOpen = false;
          return { outcome: 'INVALID' };
        }
        await lockRefreshFamily(client, family);
        const result = await client.query<QueryResultRow & {
          id: string;
          organizationId: string;
          userId: string;
          familyId: string;
          expiresAt: Date;
          revokedAt: Date | null;
          replacedById: string | null;
          role: AuthRole;
          membershipStatus: 'ACTIVE' | 'DISABLED';
          userStatus: 'ACTIVE' | 'DISABLED';
          organizationStatus: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
        }>(
          `SELECT r.id, r.organization_id AS "organizationId", r.user_id AS "userId",
                  r.family_id AS "familyId", r.expires_at AS "expiresAt",
                  r.revoked_at AS "revokedAt", r.replaced_by_id AS "replacedById",
                  m.role, m.status AS "membershipStatus", u.status AS "userStatus",
                  o.status AS "organizationStatus"
             FROM refresh_tokens r
             JOIN memberships m
               ON m.organization_id = r.organization_id AND m.user_id = r.user_id
             JOIN users u ON u.id = r.user_id
             JOIN organizations o ON o.id = r.organization_id
            WHERE r.token_hash = $1
            FOR UPDATE OF r`,
          [input.currentTokenHash],
        );
        const current = result.rows[0];
        if (!current) {
          await client.query('COMMIT');
          transactionOpen = false;
          return { outcome: 'INVALID' };
        }

        if (current.revokedAt !== null || current.replacedById !== null) {
          await client.query(
            `UPDATE refresh_tokens
                SET revoked_at = COALESCE(revoked_at, $1)
              WHERE organization_id = $2 AND family_id = $3`,
            [input.now, current.organizationId, current.familyId],
          );
          await client.query('COMMIT');
          transactionOpen = false;
          return { outcome: 'REUSED' };
        }
        if (
          current.expiresAt.getTime() <= input.now.getTime()
          || current.membershipStatus !== 'ACTIVE'
          || current.userStatus !== 'ACTIVE'
          || current.organizationStatus !== 'ACTIVE'
        ) {
          await client.query(
            `UPDATE refresh_tokens
                SET revoked_at = COALESCE(revoked_at, $1)
              WHERE organization_id = $2 AND family_id = $3`,
            [input.now, current.organizationId, current.familyId],
          );
          await client.query('COMMIT');
          transactionOpen = false;
          return { outcome: 'INVALID' };
        }

        await client.query(
          `UPDATE refresh_tokens
              SET revoked_at = $1, replaced_by_id = $2
            WHERE id = $3 AND organization_id = $4`,
          [input.now, input.nextTokenId, current.id, current.organizationId],
        );
        await client.query(
          `INSERT INTO refresh_tokens
             (id, organization_id, user_id, family_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.nextTokenId,
            current.organizationId,
            current.userId,
            current.familyId,
            input.nextTokenHash,
            input.nextExpiresAt,
          ],
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return {
          outcome: 'ROTATED',
          userId: current.userId,
          organizationId: current.organizationId,
          role: current.role,
        };
      } catch (error) {
        if (transactionOpen) {
          try {
            await client.query('ROLLBACK');
          } catch {
            discardConnection = true;
          }
        }
        throw error;
      } finally {
        client.release(discardConnection);
      }
    },

    async revokeRefreshFamily(input) {
      const client = await pool.connect();
      let transactionOpen = false;
      let discardConnection = false;
      try {
        await assertAuthRole(client);
        await client.query('BEGIN');
        transactionOpen = true;
        const family = await findRefreshFamily(client, input.tokenHash);
        if (!family) {
          await client.query('COMMIT');
          transactionOpen = false;
          return { outcome: 'INVALID' };
        }
        await lockRefreshFamily(client, family);
        const result = await client.query<QueryResultRow & {
          organizationId: string;
          familyId: string;
          revokedAt: Date | null;
        }>(
          `SELECT organization_id AS "organizationId", family_id AS "familyId",
                  revoked_at AS "revokedAt"
             FROM refresh_tokens
            WHERE token_hash = $1
            FOR UPDATE`,
          [input.tokenHash],
        );
        const current = result.rows[0];
        if (!current) {
          await client.query('COMMIT');
          transactionOpen = false;
          return { outcome: 'INVALID' };
        }
        const outcome = current.revokedAt === null ? 'REVOKED' : 'ALREADY_REVOKED';
        await client.query(
          `UPDATE refresh_tokens
              SET revoked_at = COALESCE(revoked_at, $1)
            WHERE organization_id = $2 AND family_id = $3`,
          [input.now, current.organizationId, current.familyId],
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return { outcome };
      } catch (error) {
        if (transactionOpen) {
          try {
            await client.query('ROLLBACK');
          } catch {
            discardConnection = true;
          }
        }
        throw error;
      } finally {
        client.release(discardConnection);
      }
    },

    async switchOrganization(input) {
      const client = await pool.connect();
      try {
        await assertAuthRole(client);
        const result = await client.query<QueryResultRow & {
          userId: string | null;
          organizationId: string | null;
          role: AuthRole | null;
          outcome: OrganizationSwitch['outcome'];
        }>(
          `SELECT result_user_id AS "userId",
                  result_organization_id AS "organizationId",
                  result_role AS role,
                  result_outcome AS outcome
             FROM public.switch_refresh_organization($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            input.currentTokenHash,
            input.expectedUserId,
            input.expectedOrganizationId,
            input.targetOrganizationId,
            input.now,
            input.nextTokenId,
            input.nextFamilyId,
            input.nextTokenHash,
            input.nextExpiresAt,
          ],
        );
        const row = result.rows[0];
        if (!row || row.outcome === 'INVALID') return { outcome: 'INVALID' };
        if (row.outcome === 'REUSED') return { outcome: 'REUSED' };
        if (row.outcome === 'PRESERVE_SOURCE') return { outcome: 'PRESERVE_SOURCE' };
        if (row.outcome === 'SOURCE_MISMATCH') return { outcome: 'SOURCE_MISMATCH' };
        if (row.outcome !== 'SWITCHED') {
          throw new Error('Authentication switch function returned an invalid outcome');
        }
        if (!row.userId || !row.organizationId || !row.role) {
          throw new Error('Authentication switch function returned an invalid result');
        }
        return {
          outcome: 'SWITCHED',
          userId: row.userId,
          organizationId: row.organizationId,
          role: row.role,
        };
      } finally {
        client.release();
      }
    },
  };
}
