import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import {
  createOrganization,
  runInAdminTransaction,
} from '../../src/modules/organizations/repository.js';
import { ensureLogicalBaileysAccount } from '../../src/modules/provider-accounts/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  oneRow,
  queryAs,
  queryAsTenant,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';

describe('migrations PostgreSQL', () => {
  let database: IsolatedPostgresDatabase;

  async function createOrganizationWithOwners(
    slug: string,
    ownerCount: number,
  ): Promise<{ organizationId: string; ownerIds: string[] }> {
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      const organization = await oneRow<{ id: string }>(
        client,
        'insert into organizations (name, slug) values ($1, $2) returning id',
        [`Tenant ${slug}`, slug],
      );
      const ownerIds: string[] = [];
      for (let index = 0; index < ownerCount; index += 1) {
        const owner = await oneRow<{ id: string }>(
          client,
          'insert into users (email, password_hash) values ($1, $2) returning id',
          [`${slug}-owner-${index}@example.test`, 'argon2id-test-hash'],
        );
        ownerIds.push(owner.id);
        await client.query(
          "insert into memberships (organization_id, user_id, role) values ($1, $2, 'OWNER')",
          [organization.id, owner.id],
        );
      }
      await client.query('commit');
      return { organizationId: organization.id, ownerIds };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function expectOwnerMutationRejected(
    text: string,
    values: unknown[],
    organizationId: string,
  ): Promise<void> {
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query(text, values);
      await expect(client.query('commit')).rejects.toMatchObject({
        constraint: 'organizations_require_owner',
      });
      await client.query('rollback');
    } finally {
      client.release();
    }

    const owners = await oneRow<{ count: number }>(
      database.pool,
      `select count(*)::int as count
         from memberships
        where organization_id = $1 and role = 'OWNER' and status = 'ACTIVE'`,
      [organizationId],
    );
    expect(owners.count).toBeGreaterThanOrEqual(1);
  }

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => {
      await runMigrations(database.connectionString);
      await runMigrations(database.connectionString);
    });
  }, 60_000);

  afterAll(async () => {
    await database?.dispose();
  });

  it.each([
    { roleName: 'jrc_migrator', canLogin: false },
    { roleName: 'jrc_app', canLogin: true },
    { roleName: 'jrc_auth', canLogin: true },
  ])('mantém os atributos mínimos da role $roleName', async ({ roleName, canLogin }) => {
    const role = await oneRow<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolsuper: boolean;
    }>(
      database.pool,
      `select rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole,
              rolinherit, rolreplication, rolsuper
         from pg_roles where rolname = $1`,
      [roleName],
    );

    expect(role).toEqual({
      rolbypassrls: false,
      rolcanlogin: canLogin,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolsuper: false,
    });
  });

  it('executa migrations como jrc_migrator e mantém ownership integral', async () => {
    const objects = await database.pool.query<{
      kind: string;
      name: string;
      owner: string;
    }>(
      `select 'schema' as kind, n.nspname as name, r.rolname as owner
         from pg_namespace n
         join pg_roles r on r.oid = n.nspowner
        where n.nspname in ('public', 'drizzle')
       union all
       select case when c.relkind = 'S' then 'sequence' else 'table' end,
              n.nspname || '.' || c.relname,
              r.rolname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles r on r.oid = c.relowner
        where n.nspname in ('public', 'drizzle')
          and c.relkind in ('r', 'p', 'S')
       union all
       select 'type', n.nspname || '.' || t.typname, r.rolname
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
         join pg_roles r on r.oid = t.typowner
        where n.nspname = 'public' and t.typtype = 'e'
       union all
       select 'function', n.nspname || '.' || p.proname, r.rolname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_roles r on r.oid = p.proowner
        where p.oid in (
          'public.ensure_organization_has_owner()'::regprocedure,
          'public.consume_login_selection(text,uuid,timestamptz,uuid,uuid,text,timestamptz)'::regprocedure,
          'public.switch_refresh_organization(text,uuid,uuid,uuid,timestamptz,uuid,uuid,text,timestamptz)'::regprocedure
        )
       order by kind, name`,
    );

    expect(objects.rows.length).toBeGreaterThan(0);
    expect(objects.rows.every(({ owner }) => owner === 'jrc_migrator')).toBe(true);
    expect(objects.rows).toEqual(expect.arrayContaining([
      { kind: 'schema', name: 'public', owner: 'jrc_migrator' },
      { kind: 'schema', name: 'drizzle', owner: 'jrc_migrator' },
      { kind: 'table', name: 'drizzle.__drizzle_migrations', owner: 'jrc_migrator' },
      { kind: 'type', name: 'public.membership_status', owner: 'jrc_migrator' },
      { kind: 'type', name: 'public.provider_kind', owner: 'jrc_migrator' },
      {
        kind: 'function',
        name: 'public.ensure_organization_has_owner',
        owner: 'jrc_migrator',
      },
      {
        kind: 'function',
        name: 'public.switch_refresh_organization',
        owner: 'jrc_migrator',
      },
    ]));
  });

  it('revoga privilégios PUBLIC dos objetos da aplicação', async () => {
    const privileges = await database.pool.query<{ kind: string; name: string; privilege: string }>(
      `select 'schema' as kind, n.nspname as name, acl.privilege_type as privilege
         from pg_namespace n
         cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) acl
        where n.nspname in ('public', 'drizzle') and acl.grantee = 0
       union all
       select case when c.relkind = 'S' then 'sequence' else 'table' end,
              n.nspname || '.' || c.relname,
              acl.privilege_type
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(coalesce(
           c.relacl,
           acldefault((case when c.relkind = 'S' then 'S' else 'r' end)::"char", c.relowner)
         )) acl
        where n.nspname in ('public', 'drizzle')
          and c.relkind in ('r', 'p', 'S')
          and acl.grantee = 0
       union all
       select 'type', n.nspname || '.' || t.typname, acl.privilege_type
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
         cross join lateral aclexplode(coalesce(t.typacl, acldefault('T'::"char", t.typowner))) acl
        where n.nspname = 'public' and t.typtype = 'e' and acl.grantee = 0
       union all
       select 'function', n.nspname || '.' || p.proname, acl.privilege_type
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) acl
        where n.nspname = 'public'
          and p.proname in (
            'ensure_organization_has_owner',
            'consume_login_selection',
            'switch_refresh_organization'
          )
          and acl.grantee = 0`,
    );

    expect(privileges.rows).toEqual([]);
  });

  it('nega à role de autenticação acesso às instâncias', async () => {
    await expect(queryAs(database.pool, 'jrc_auth', 'select * from instances'))
      .rejects.toThrow(/permission denied/i);
  });

  it('aplica a matriz completa de grants das roles de runtime', async () => {
    const tables = [
      'api_keys',
      'audit_logs',
      'connection_challenges',
      'idempotency_records',
      'instances',
      'login_sessions',
      'memberships',
      'messaging_bot_jobs',
      'messaging_channels',
      'messaging_contacts',
      'messaging_conversations',
      'messaging_inbox_events',
      'messaging_messages',
      'messaging_outbox',
      'messaging_status_events',
      'organizations',
      'provider_accounts',
      'provider_operations',
      'refresh_tokens',
      'security_audit_logs',
      'users',
    ];
    const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];
    const allBusinessPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
    const expected = new Map<string, readonly string[]>([
      ['jrc_auth:organizations', ['SELECT']],
      ['jrc_auth:users', ['SELECT']],
      ['jrc_auth:memberships', ['SELECT']],
      // 0043 requires create_login_selection to serialize admission with reset.
      ['jrc_auth:login_sessions', []],
      ['jrc_auth:refresh_tokens', ['SELECT', 'INSERT', 'UPDATE']],
      ['jrc_auth:security_audit_logs', ['INSERT']],
      ['jrc_app:organizations', ['SELECT']],
      ['jrc_app:memberships', allBusinessPrivileges],
      ['jrc_app:api_keys', allBusinessPrivileges],
      ['jrc_app:audit_logs', ['INSERT']],
      ['jrc_app:provider_accounts', allBusinessPrivileges],
      ['jrc_app:instances', allBusinessPrivileges],
      ['jrc_app:provider_operations', allBusinessPrivileges],
      ['jrc_app:connection_challenges', allBusinessPrivileges],
      ['jrc_app:idempotency_records', allBusinessPrivileges],
      ['jrc_app:messaging_bot_jobs', allBusinessPrivileges],
      ['jrc_app:messaging_channels', allBusinessPrivileges],
      ['jrc_app:messaging_contacts', allBusinessPrivileges],
      ['jrc_app:messaging_conversations', allBusinessPrivileges],
      ['jrc_app:messaging_inbox_events', allBusinessPrivileges],
      ['jrc_app:messaging_messages', allBusinessPrivileges],
      ['jrc_app:messaging_outbox', allBusinessPrivileges],
      ['jrc_app:messaging_status_events', allBusinessPrivileges],
    ]);

    for (const role of ['jrc_app', 'jrc_auth']) {
      for (const table of tables) {
        for (const privilege of privileges) {
          const permission = await oneRow<{ allowed: boolean }>(
            database.pool,
            'select has_table_privilege($1, $2, $3) as allowed',
            [role, table, privilege],
          );
          expect(
            permission.allowed,
            `${role} ${privilege} on ${table}`,
          ).toBe(expected.get(`${role}:${table}`)?.includes(privilege) ?? false);
        }
      }
    }
  });

  it('habilita e força RLS em todas as tabelas multicliente', async () => {
    const expectedTables = [
      'api_keys',
      'audit_logs',
      'chatwoot_embed_apps',
      'chatwoot_embed_authorizations',
      'chatwoot_embed_sessions',
      'connection_challenges',
      'idempotency_records',
      'instances',
      'memberships',
      'messaging_bot_jobs',
      'messaging_channels',
      'messaging_contacts',
      'messaging_conversations',
      'messaging_inbox_events',
      'messaging_messages',
      'messaging_outbox',
      'messaging_status_events',
      'organizations',
      'provider_accounts',
      'provider_operations',
      'refresh_tokens',
    ];
    const result = await database.pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class
        where relnamespace = 'public'::regnamespace
          and relname = any($1::text[])
        order by relname`,
      [expectedTables],
    );

    expect(result.rows).toEqual(expectedTables.map((relname) => ({
      relname,
      relrowsecurity: true,
      relforcerowsecurity: true,
    })));
  });

  it('mantém policies limitadas aos comandos previstos', async () => {
    const catalogue=(await database.pool.query<{table_name:string}>(
      'select table_name from lifecycle_purge_catalogue order by table_name')).rows.map(row=>row.table_name);
    const tenantTables=(await database.pool.query<{table_name:string}>(`
      select c.relname as table_name from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_attribute a on a.attrelid=c.oid and a.attname='organization_id' and not a.attisdropped
      where n.nspname='public' and c.relkind='r' and c.relname not in ('lifecycle_deletions','lifecycle_cleanup_items')
      order by c.relname`)).rows.map(row=>row.table_name);
    expect(catalogue).toEqual(tenantTables);
    // 0036 uses maintenance_boundary on these catalogued commercial tables,
    // not lifecycle_migrator. Keep the rest of the historical inventory strict.
    const lifecycleManaged=catalogue.filter(table=>!['support_tickets','support_messages',
      'commercial_plans','commercial_plan_versions','organization_commercial_plans'].includes(table)).length+1;
    const result = await database.pool.query<{
      policyname: string;
      roles: string[];
      cmd: string;
    }>(
      `select policyname, roles::text[] as roles, cmd
         from pg_policies
        where schemaname = 'public'
        order by policyname`,
    );

    expect(result.rows).toEqual([
      // 0034 (2) + 0039 (3) + 0042 (1) + 0044 (1) + 0045 (2).
      ...Array.from({length:9},()=>({policyname:'attendance_tenant',roles:['jrc_app'],cmd:'ALL'})),
      ...Array.from({length:2},()=>({policyname:'central_tenant',roles:['jrc_app'],cmd:'ALL'})),
      // 0043 revokes delegated access through the restricted definer function.
      {policyname:'embed_authorizations_auth_revoke',roles:['jrc_migrator'],cmd:'UPDATE'},
      {policyname:'embed_sessions_auth_revoke',roles:['jrc_migrator'],cmd:'UPDATE'},
      // 0038: one policy on economic_groups and two per removal table.
      {policyname:'group_removal_group_migrator',roles:['jrc_migrator'],cmd:'ALL'},
      ...Array.from({length:3},()=>({policyname:'group_removal_migrator',roles:['jrc_migrator'],cmd:'ALL'})),
      ...Array.from({length:3},()=>({policyname:'group_removal_platform',roles:['jrc_platform'],cmd:'SELECT'})),
      // 0036: private legacy plans/global catalogue stay outside the tenant role.
      {policyname:'lifecycle_boundary',roles:['jrc_lifecycle'],cmd:'ALL'},
      ...Array.from({length:3},()=>({policyname:'maintenance_boundary',roles:['jrc_migrator'],cmd:'ALL'})),
      ...Array.from({length:3},()=>({policyname:'platform_boundary',roles:['jrc_platform'],cmd:'ALL'})),
      ...Array.from({length:5},()=>({policyname:'automation_integration_tenant',roles:['jrc_app'],cmd:'ALL'})),
      ...Array.from({length:2},()=>({policyname:'automation_migration_tenant',roles:['jrc_app'],cmd:'ALL'})),
      ...Array.from({length:8},()=>({policyname:'automation_tenant',roles:['jrc_app'],cmd:'ALL'})),
      ...Array.from({length:2},()=>({policyname:'operational_tenant',roles:['jrc_app'],cmd:'ALL'})),
      {policyname:'legacy_flow_discovery',roles:['jrc_migrator'],cmd:'SELECT'},
      {policyname:'lifecycle_catalogue_migrator',roles:['jrc_migrator'],cmd:'ALL'},
      {policyname:'lifecycle_cleanup_migrator',roles:['jrc_migrator'],cmd:'ALL'},
      {policyname:'lifecycle_cleanup_worker',roles:['jrc_lifecycle'],cmd:'ALL'},
      {policyname:'lifecycle_login_sessions_migrator',roles:['jrc_migrator'],cmd:'ALL'},
      {policyname:'lifecycle_memberships_worker',roles:['jrc_lifecycle'],cmd:'SELECT'},
      ...Array.from({length:lifecycleManaged},()=>({policyname:'lifecycle_migrator',roles:['jrc_migrator'],cmd:'ALL'})),
      {policyname:'lifecycle_platform',roles:['jrc_platform'],cmd:'SELECT'},
      {policyname:'lifecycle_platform_users_migrator',roles:['jrc_migrator'],cmd:'SELECT'},
      {policyname:'lifecycle_platform_users_worker',roles:['jrc_lifecycle'],cmd:'SELECT'},
      {policyname:'lifecycle_users_migrator',roles:['jrc_migrator'],cmd:'ALL'},
      {policyname:'lifecycle_users_worker',roles:['jrc_lifecycle'],cmd:'SELECT'},
      {policyname:'lifecycle_worker',roles:['jrc_lifecycle'],cmd:'ALL'},
      ...Array.from({length:10},()=>({policyname:'flow_tenant',roles:['jrc_app'],cmd:'ALL'})),
      {policyname:'flow_platform',roles:['jrc_platform'],cmd:'ALL'},
      {policyname:'flow_ingress_resolution',roles:['jrc_migrator'],cmd:'SELECT'},
      { policyname:'limits_tenant_read',roles:['jrc_app'],cmd:'SELECT' },
      { policyname:'limits_platform',roles:['jrc_platform'],cmd:'ALL' },
      { policyname:'limits_integrity',roles:['jrc_migrator'],cmd:'ALL' },
      { policyname:'usage_tenant_read',roles:['jrc_app'],cmd:'SELECT' },
      { policyname:'usage_platform_read',roles:['jrc_platform'],cmd:'SELECT' },
      { policyname:'usage_integrity',roles:['jrc_migrator'],cmd:'ALL' },
      { policyname:'messages_quota_integrity',roles:['jrc_migrator'],cmd:'SELECT' },
      { policyname:'instances_quota_integrity',roles:['jrc_migrator'],cmd:'SELECT' },
      { policyname:'channels_quota_integrity',roles:['jrc_migrator'],cmd:'SELECT' },
      { policyname:'meta_signup_states_tenant',roles:['jrc_app'],cmd:'ALL' },
      { policyname:'meta_connections_tenant',roles:['jrc_app'],cmd:'ALL' },
      { policyname:'meta_connections_lookup',roles:['jrc_migrator'],cmd:'SELECT' },
      {policyname:'messaging_channels_ingress_resolution',roles:['jrc_migrator'],cmd:'SELECT'},
      {policyname:'chatwoot_ingress_resolution',roles:['jrc_migrator'],cmd:'SELECT'},
      ...['chatwoot_embed_apps','chatwoot_embed_authorizations','chatwoot_embed_sessions'].flatMap(table => [
        {policyname:table+'_tenant',roles:['jrc_app'],cmd:'ALL'},
        {policyname:table+'_lookup',roles:['jrc_migrator'],cmd:'SELECT'},
      ]),
      ...['chatwoot_connection_health','chatwoot_control_bindings','chatwoot_destinations','chatwoot_onboarding','chatwoot_operator_grants']
        .map(table=>({policyname:table+'_tenant',roles:['jrc_app'],cmd:'ALL'})),
      {policyname:'chatwoot_destinations_platform',roles:['jrc_platform'],cmd:'ALL'},
      {policyname:'chatwoot_destinations_legacy_insert',roles:['jrc_migrator'],cmd:'ALL'},
      ...['chatwoot_accounts','chatwoot_connections','chatwoot_conversations','chatwoot_messages','integration_jobs','integration_audit','chatwoot_provisioning','messaging_media'].map(table=>({policyname:table+'_tenant',roles:['jrc_app'],cmd:'ALL'})),
      ...Array.from({length:6},()=>({policyname:'platform_boundary',roles:['jrc_platform'],cmd:'ALL'})),
      ...Array.from({length:3},()=>({policyname:'platform_administration',roles:['jrc_platform'],cmd:'ALL'})),
      ...Array.from({length:4},()=>({policyname:'platform_monitor',roles:['jrc_platform'],cmd:'SELECT'})),
      ...Array.from({length:2},()=>({policyname:'maintenance_boundary',roles:['jrc_migrator'],cmd:'ALL'})),
      ...Array.from({length:2},()=>({policyname:'platform_boundary',roles:['jrc_platform'],cmd:'ALL'})),
      ...Array.from({length:2},()=>({policyname:'tenant_boundary',roles:['jrc_app'],cmd:'ALL'})),
      { policyname:'platform_provider_bootstrap',roles:['jrc_platform'],cmd:'INSERT' },
      { policyname:'platform_channel_monitor',roles:['jrc_platform'],cmd:'SELECT' },
      { policyname: 'api_keys_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'audit_logs_migrator_insert', roles: ['jrc_migrator'], cmd: 'INSERT' },
      { policyname: 'audit_logs_tenant_insert', roles: ['jrc_app'], cmd: 'INSERT' },
      { policyname: 'connection_challenges_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'idempotency_records_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'instances_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'memberships_auth_read', roles: ['jrc_auth'], cmd: 'SELECT' },
      { policyname: 'memberships_migrator_integrity', roles: ['jrc_migrator'], cmd: 'ALL' },
      { policyname: 'memberships_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'messaging_bot_jobs_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'messaging_channels_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'messaging_contacts_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'messaging_conversations_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'messaging_inbox_events_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'messaging_messages_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'messaging_outbox_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'messaging_status_events_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'organizations_auth_read', roles: ['jrc_auth'], cmd: 'SELECT' },
      { policyname: 'organizations_migrator_integrity', roles: ['jrc_migrator'], cmd: 'ALL' },
      { policyname: 'organizations_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      {
        policyname: 'provider_accounts_migrator_onboarding_insert',
        roles: ['jrc_migrator'],
        cmd: 'INSERT',
      },
      {
        policyname: 'provider_accounts_migrator_onboarding_read',
        roles: ['jrc_migrator'],
        cmd: 'SELECT',
      },
      {
        policyname: 'provider_accounts_migrator_onboarding_update',
        roles: ['jrc_migrator'],
        cmd: 'UPDATE',
      },
      { policyname: 'provider_accounts_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'provider_operations_tenant_isolation', roles: ['jrc_app'], cmd: 'ALL' },
      { policyname: 'refresh_tokens_auth_access', roles: ['jrc_auth'], cmd: 'ALL' },
      { policyname: 'refresh_tokens_migrator_auth_insert', roles: ['jrc_migrator'], cmd: 'INSERT' },
      { policyname: 'refresh_tokens_migrator_auth_read', roles: ['jrc_migrator'], cmd: 'SELECT' },
      { policyname: 'refresh_tokens_migrator_auth_update', roles: ['jrc_migrator'], cmd: 'UPDATE' },
    ].sort((a,b)=>a.policyname.localeCompare(b.policyname)));
  });

  it('checks the reviewed 0034-0045 policy tables, expressions and restricted grants', async () => {
    const attendanceTables = [
      'attendance_owners', 'attendance_sessions', 'chatwoot_attendance_controls',
      'chatwoot_mirror_attempts', 'chatwoot_attendance_observations', 'attendance_handoff_operations', 'attendance_resume_operations',
      'local_attendance_teams', 'local_attendance_team_members',
    ];
    const commercialTables = ['commercial_plans', 'commercial_plan_versions', 'organization_commercial_plans'];
    const removalTables = ['group_company_removal_previews', 'group_company_removals', 'group_company_removal_children'];
    const centralTables = ['central_transport_bindings','central_runtime_events'];
    const tables = [...attendanceTables, ...centralTables, ...commercialTables, ...removalTables];
    type ReviewedPolicy = { tablename: string; policyname: string; roles: string[]; cmd: string;
      permissive: string; qual: string | null; with_check: string | null };
    const connection = await database.pool.connect();
    try {
      await connection.query('BEGIN');
      // This is a fixed specification, never an expectation copied from the actual
      // migrated policies. PostgreSQL parses it so formatting/casts are comparable.
      await connection.query('CREATE TEMP TABLE reviewed_rls_reference(organization_id uuid) ON COMMIT DROP');
      await connection.query(`CREATE POLICY expected_tenant ON reviewed_rls_reference TO jrc_app
        USING (organization_id = NULLIF(current_setting('app.organization_id',true),'')::uuid)
        WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id',true),'')::uuid)`);
      const reference = (await connection.query<{ qual: string; with_check: string }>(`
        SELECT pg_get_expr(polqual,polrelid) AS qual, pg_get_expr(polwithcheck,polrelid) AS with_check
        FROM pg_policy WHERE polrelid='pg_temp.reviewed_rls_reference'::regclass AND polname='expected_tenant'`)).rows[0]!;
      const policy = (tablename: string, policyname: string, role: string, cmd = 'ALL',
        qual: string | null = 'true', withCheck: string | null = 'true'): ReviewedPolicy =>
        ({ tablename, policyname, roles: [role], cmd, permissive: 'PERMISSIVE', qual, with_check: withCheck });
      const expected: ReviewedPolicy[] = [
        ...attendanceTables.flatMap(table => [
          policy(table, 'attendance_tenant', 'jrc_app', 'ALL', reference.qual, reference.with_check),
          policy(table, 'lifecycle_migrator', 'jrc_migrator'),
        ]),
        ...centralTables.flatMap(table => [
          policy(table, 'central_tenant', 'jrc_app', 'ALL', reference.qual, reference.with_check),
          policy(table, 'lifecycle_migrator', 'jrc_migrator'),
        ]),
        ...commercialTables.flatMap(table => [
          policy(table, 'platform_boundary', 'jrc_platform'),
          policy(table, 'maintenance_boundary', 'jrc_migrator'),
        ]),
        policy('organization_commercial_plans', 'lifecycle_boundary', 'jrc_lifecycle', 'ALL', 'true', null),
        ...removalTables.flatMap(table => [
          policy(table, 'group_removal_migrator', 'jrc_migrator'),
          policy(table, 'group_removal_platform', 'jrc_platform', 'SELECT', 'true', null),
        ]),
        policy('economic_groups', 'group_removal_group_migrator', 'jrc_migrator'),
      ];
      const actual = (await connection.query<ReviewedPolicy>(`
        SELECT tablename,policyname,roles::text[] AS roles,cmd,permissive,qual,with_check
        FROM pg_policies WHERE schemaname='public' AND
          (tablename=ANY($1::text[]) OR (tablename='economic_groups' AND policyname='group_removal_group_migrator'))`,
        [tables])).rows;
      const ordered = (rows: ReviewedPolicy[]) => [...rows].sort((a,b) =>
        `${a.tablename}:${a.policyname}`.localeCompare(`${b.tablename}:${b.policyname}`));
      expect(ordered(actual)).toEqual(ordered(expected));
      const flags = (await connection.query<{ tablename: string; owner: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
        SELECT c.relname AS tablename,r.rolname AS owner,c.relrowsecurity,c.relforcerowsecurity
        FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
        WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[])`, [tables])).rows;
      expect(flags.sort((a,b)=>a.tablename.localeCompare(b.tablename))).toEqual([...tables].sort().map(tablename =>
        ({ tablename, owner: 'jrc_migrator', relrowsecurity: true, relforcerowsecurity: true })));
      // Policies and SQL privileges are separate gates. A broad administrative
      // policy must not accidentally grant the tenant/authentication roles access.
      for (const table of tables) {
        const grants = (await connection.query<{ app_select: boolean; app_insert: boolean; app_update: boolean;
          app_delete: boolean; auth_select: boolean; auth_insert: boolean; auth_update: boolean; auth_delete: boolean }>(`
          SELECT has_table_privilege('jrc_app',$1,'SELECT') AS app_select,
            has_table_privilege('jrc_app',$1,'INSERT') AS app_insert,
            has_table_privilege('jrc_app',$1,'UPDATE') AS app_update,
            has_table_privilege('jrc_app',$1,'DELETE') AS app_delete,
            has_table_privilege('jrc_auth',$1,'SELECT') AS auth_select,
            has_table_privilege('jrc_auth',$1,'INSERT') AS auth_insert,
            has_table_privilege('jrc_auth',$1,'UPDATE') AS auth_update,
            has_table_privilege('jrc_auth',$1,'DELETE') AS auth_delete`, [`public.${table}`])).rows[0];
        const tenantAccess = attendanceTables.includes(table) || centralTables.includes(table);
        expect(grants, table).toEqual({ app_select: tenantAccess, app_insert: tenantAccess,
          app_update: tenantAccess, app_delete: table === 'local_attendance_team_members', auth_select: false, auth_insert: false,
          auth_update: false, auth_delete: false });
      }
      for (const table of ['local_attendance_teams', 'local_attendance_team_members']) {
        const grants = (await connection.query(`SELECT
          has_table_privilege('jrc_platform',$1,'SELECT') AS can_select,
          has_table_privilege('jrc_platform',$1,'INSERT') AS can_insert,
          has_table_privilege('jrc_platform',$1,'UPDATE') AS can_update,
          has_table_privilege('jrc_platform',$1,'DELETE') AS can_delete`, [`public.${table}`])).rows[0];
        expect(grants, table).toEqual({ can_select: false, can_insert: false, can_update: false, can_delete: false });
      }
      for (const table of removalTables) {
        const grants = (await connection.query(`SELECT
          has_table_privilege('jrc_platform',$1,'SELECT') AS can_select,
          has_table_privilege('jrc_platform',$1,'INSERT') AS can_insert,
          has_table_privilege('jrc_platform',$1,'UPDATE') AS can_update,
          has_table_privilege('jrc_platform',$1,'DELETE') AS can_delete`, [`public.${table}`])).rows[0];
        expect(grants, table).toEqual({ can_select: true, can_insert: false, can_update: false, can_delete: false });
      }
      const publishedGrants = (await connection.query(`SELECT
        has_table_privilege('jrc_platform','public.commercial_plan_versions','SELECT') AS can_select,
        has_table_privilege('jrc_platform','public.commercial_plan_versions','INSERT') AS can_insert,
        has_table_privilege('jrc_platform','public.commercial_plan_versions','UPDATE') AS can_update,
        has_table_privilege('jrc_platform','public.commercial_plan_versions','DELETE') AS can_delete`)).rows[0];
      expect(publishedGrants).toEqual({ can_select: true, can_insert: true, can_update: false, can_delete: false });
    } finally {
      try { await connection.query('ROLLBACK'); } finally { connection.release(); }
    }
  });

  it('permite ao executor administrativo apenas o onboarding sujeito a FORCE RLS', async () => {
    const requestId = '5e747358-e4f9-491f-9011-12b259d2d210';
    const created = await runInAdminTransaction(database.pool, async (transaction) => {
      const organization = await createOrganization(transaction, {
        name: 'Administrative RLS Tenant',
        slug: 'administrative-rls-tenant',
      });
      const owner = await createUser(transaction, {
        email: 'administrative-rls-owner@example.test',
        passwordHash: 'argon2id-test-hash',
      });
      await createOwnerMembership(transaction, {
        organizationId: organization.id,
        userId: owner.id,
      });

      const firstProvider = await ensureLogicalBaileysAccount(transaction, organization.id);
      const sameProvider = await ensureLogicalBaileysAccount(transaction, organization.id);
      await writeTenantAudit(transaction as unknown as TenantTransaction, {
        type: 'MEMBERSHIP_CHANGED',
        organizationId: organization.id,
        actorId: owner.id,
        resourceId: owner.id,
        requestId,
      });

      return {
        organizationId: organization.id,
        firstProviderId: firstProvider.id,
        sameProviderId: sameProvider.id,
      };
    });

    expect(created.sameProviderId).toBe(created.firstProviderId);
    const persisted = await oneRow<{ auditCount: number; providerCount: number }>(
      database.pool,
      `select
         (select count(*)::int from provider_accounts
           where organization_id = $1 and provider = 'BAILEYS') as "providerCount",
         (select count(*)::int from audit_logs
           where organization_id = $1 and request_id = $2) as "auditCount"`,
      [created.organizationId, requestId],
    );
    expect(persisted).toEqual({ auditCount: 1, providerCount: 1 });
  });

  it('não revela linhas multicliente para jrc_app sem contexto de tenant', async () => {
    const tenant = await createOrganizationWithOwners('no-tenant-context', 1);
    const providerAccount = await oneRow<{ id: string }>(
      database.pool,
      `insert into provider_accounts (organization_id, provider, name)
       values ($1, 'BAILEYS', 'provider-no-context') returning id`,
      [tenant.organizationId],
    );
    await database.pool.query(
      `insert into instances
         (organization_id, provider_account_id, name, upstream_instance_key)
       values ($1, $2, 'instance-no-context', 'upstream-no-context')`,
      [tenant.organizationId, providerAccount.id],
    );

    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role jrc_app');
      const context = await oneRow<{ organization_id: string | null }>(
        client,
        "select nullif(current_setting('app.organization_id', true), '') as organization_id",
      );
      const visible = await oneRow<{ organizations: number; instances: number }>(
        client,
        `select (select count(*)::int from organizations) as organizations,
                (select count(*)::int from instances) as instances`,
      );
      expect(context.organization_id).toBeNull();
      expect(visible).toEqual({ organizations: 0, instances: 0 });
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('permite somente INSERT de audit_logs para jrc_app', async () => {
    const privileges = await oneRow<{
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      can_truncate: boolean;
    }>(
      database.pool,
      `select has_table_privilege('jrc_app', 'audit_logs', 'INSERT') as can_insert,
              has_table_privilege('jrc_app', 'audit_logs', 'UPDATE') as can_update,
              has_table_privilege('jrc_app', 'audit_logs', 'DELETE') as can_delete,
              has_table_privilege('jrc_app', 'audit_logs', 'TRUNCATE') as can_truncate`,
    );
    expect(privileges).toEqual({
      can_insert: true,
      can_update: false,
      can_delete: false,
      can_truncate: false,
    });

    const admin = await database.pool.connect();
    let organizationId: string;
    let auditLogId: string;
    try {
      await admin.query('begin');
      const organization = await oneRow<{ id: string }>(
        admin,
        "insert into organizations (name, slug) values ('Audit Tenant', 'audit-tenant') returning id",
      );
      organizationId = organization.id;
      const owner = await oneRow<{ id: string }>(
        admin,
        "insert into users (email, password_hash) values ('audit-owner@example.test', 'argon2id-test-hash') returning id",
      );
      await admin.query(
        "insert into memberships (organization_id, user_id, role) values ($1, $2, 'OWNER')",
        [organizationId, owner.id],
      );
      const auditLog = await oneRow<{ id: string }>(
        admin,
        `insert into audit_logs
           (organization_id, event_type, resource_type, outcome)
         values ($1, 'seed.created', 'test', 'SUCCESS')
         returning id`,
        [organizationId],
      );
      auditLogId = auditLog.id;
      await admin.query('commit');
    } catch (error) {
      await admin.query('rollback');
      throw error;
    } finally {
      admin.release();
    }

    await expect(queryAsTenant(
      database.pool,
      'jrc_app',
      organizationId,
      `insert into audit_logs
         (organization_id, event_type, resource_type, outcome)
       values ($1, 'runtime.created', 'test', 'SUCCESS')`,
      [organizationId],
    )).resolves.toBeDefined();
    await expect(queryAsTenant(
      database.pool,
      'jrc_app',
      organizationId,
      "update audit_logs set outcome = 'ALTERED' where organization_id = $1 and id = $2",
      [organizationId, auditLogId],
    )).rejects.toThrow(/permission denied/i);
    await expect(queryAsTenant(
      database.pool,
      'jrc_app',
      organizationId,
      'delete from audit_logs where organization_id = $1 and id = $2',
      [organizationId, auditLogId],
    )).rejects.toThrow(/permission denied/i);
    await expect(queryAsTenant(
      database.pool,
      'jrc_app',
      organizationId,
      'truncate table audit_logs',
    )).rejects.toThrow(/permission denied/i);
  });

  it.each([
    'idempotency_records_org_route_key_unique',
    'instances_upstream_instance_key_unique',
    'api_keys_prefix_global_unique',
  ])('cria a constraint nomeada %s', async (constraintName) => {
    const row = await oneRow<{ exists: boolean }>(
      database.pool,
      'select exists(select 1 from pg_constraint where conname = $1) as exists',
      [constraintName],
    );

    expect(row.exists).toBe(true);
  });

  it('preserva a operação durável referenciada e impede vínculo idempotente cross-tenant', async () => {
    const firstTenant = await createOrganizationWithOwners('idempotency-first', 1);
    const secondTenant = await createOrganizationWithOwners('idempotency-second', 1);

    async function createOperation(organizationId: string, suffix: string): Promise<string> {
      const providerAccount = await oneRow<{ id: string }>(
        database.pool,
        `insert into provider_accounts (organization_id, provider, name)
         values ($1, 'BAILEYS', $2) returning id`,
        [organizationId, `provider-${suffix}`],
      );
      const instance = await oneRow<{ id: string }>(
        database.pool,
        `insert into instances
           (organization_id, provider_account_id, name, upstream_instance_key)
         values ($1, $2, $3, $4) returning id`,
        [organizationId, providerAccount.id, `instance-${suffix}`, `upstream-${suffix}`],
      );
      const operation = await oneRow<{ id: string }>(
        database.pool,
        `insert into provider_operations (organization_id, instance_id, operation_type)
         values ($1, $2, 'PROVISION') returning id`,
        [organizationId, instance.id],
      );
      return operation.id;
    }

    const firstOperationId = await createOperation(firstTenant.organizationId, 'first');
    const secondOperationId = await createOperation(secondTenant.organizationId, 'second');
    const idempotency = await oneRow<{ id: string }>(
      database.pool,
      `insert into idempotency_records
         (organization_id, route, idempotency_key, request_hash, operation_id, expires_at)
       values ($1, '/v1/instances', 'key-first', 'request-hash', $2, now() + interval '1 hour')
       returning id`,
      [firstTenant.organizationId, firstOperationId],
    );

    await expect(
      database.pool.query('delete from provider_operations where id = $1', [firstOperationId]),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'idempotency_records_operation_fk',
    });
    await expect(
      database.pool.query(
        'update idempotency_records set operation_id = $1 where id = $2',
        [secondOperationId, idempotency.id],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'idempotency_records_operation_fk',
    });

    const persisted = await oneRow<{ organization_id: string; operation_id: string }>(
      database.pool,
      'select organization_id, operation_id from idempotency_records where id = $1',
      [idempotency.id],
    );
    expect(persisted).toEqual({
      organization_id: firstTenant.organizationId,
      operation_id: firstOperationId,
    });
  });

  it('cria todas as entidades do Incremento 1', async () => {
    const expectedTables = [
      'api_keys',
      'audit_logs',
      'connection_challenges',
      'idempotency_records',
      'instances',
      'login_sessions',
      'memberships',
      'messaging_bot_jobs',
      'messaging_channels',
      'messaging_contacts',
      'messaging_conversations',
      'messaging_inbox_events',
      'messaging_messages',
      'messaging_outbox',
      'messaging_status_events',
      'organizations',
      'provider_accounts',
      'provider_operations',
      'refresh_tokens',
      'security_audit_logs',
      'users',
    ];
    const result = await database.pool.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
          and table_name = any($1::text[])
        order by table_name`,
      [expectedTables],
    );

    expect(result.rows.map(({ table_name }) => table_name)).toEqual(expectedTables);
  });

  it('rejeita a exclusão do único OWNER', async () => {
    const tenant = await createOrganizationWithOwners('owner-delete', 1);
    await expectOwnerMutationRejected(
      'delete from memberships where organization_id = $1 and user_id = $2',
      [tenant.organizationId, tenant.ownerIds[0]],
      tenant.organizationId,
    );
  });

  it('rejeita o rebaixamento do único OWNER', async () => {
    const tenant = await createOrganizationWithOwners('owner-downgrade', 1);
    await expectOwnerMutationRejected(
      "update memberships set role = 'ADMIN' where organization_id = $1 and user_id = $2",
      [tenant.organizationId, tenant.ownerIds[0]],
      tenant.organizationId,
    );
  });

  it('rejeita a desativação do único OWNER', async () => {
    const tenant = await createOrganizationWithOwners('owner-disable', 1);
    await expectOwnerMutationRejected(
      "update memberships set status = 'DISABLED' where organization_id = $1 and user_id = $2",
      [tenant.organizationId, tenant.ownerIds[0]],
      tenant.organizationId,
    );
  });

  it('rejeita mover o único OWNER e valida a organização de origem', async () => {
    const source = await createOrganizationWithOwners('owner-move-source', 1);
    const destination = await createOrganizationWithOwners('owner-move-destination', 1);
    await expectOwnerMutationRejected(
      'update memberships set organization_id = $1 where organization_id = $2 and user_id = $3',
      [destination.organizationId, source.organizationId, source.ownerIds[0]],
      source.organizationId,
    );
  });

  it('serializa remoções concorrentes e deixa ao menos um OWNER ativo', async () => {
    const tenant = await createOrganizationWithOwners('owner-concurrent', 2);
    const first = await database.pool.connect();
    const second = await database.pool.connect();
    try {
      await Promise.all([first.query('begin'), second.query('begin')]);
      await Promise.all([
        first.query(
          'delete from memberships where organization_id = $1 and user_id = $2',
          [tenant.organizationId, tenant.ownerIds[0]],
        ),
        second.query(
          "update memberships set role = 'ADMIN' where organization_id = $1 and user_id = $2",
          [tenant.organizationId, tenant.ownerIds[1]],
        ),
      ]);

      const commits = await Promise.allSettled([
        first.query('commit'),
        second.query('commit'),
      ]);
      expect(commits.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(commits.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      await Promise.allSettled([first.query('rollback'), second.query('rollback')]);
    } finally {
      first.release();
      second.release();
    }

    const owners = await oneRow<{ count: number }>(
      database.pool,
      `select count(*)::int as count
         from memberships
        where organization_id = $1 and role = 'OWNER' and status = 'ACTIVE'`,
      [tenant.organizationId],
    );
    expect(owners.count).toBe(1);
  });
});
