import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Pool } from 'pg';
import { hashPassword, initializePasswordVerifier } from '@jrc/security';
import { buildApp } from '../../../api/src/app.js';
import { runMigrations } from '../../../api/src/db/migrate.js';
import { withOrganizationTransaction, type OrganizationTransaction } from '../../../api/src/db/tenant-transaction.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl } from '../../../api/tests/integration/helpers/postgres.js';
import { withGlobalRoleLock } from '../../../api/tests/integration/helpers/global-role-lock.js';
import { createOrganization, runInAdminTransaction } from '../../../api/src/modules/organizations/repository.js';
import { createPostgresAuthRepository } from '../../../api/src/modules/auth/repository.js';
import { MemoryRateLimitStore } from '../../../api/src/modules/auth/rate-limit/memory-store.js';
import { createSecurityAuditWriter } from '../../../api/src/modules/audit/security-audit.js';
import { writeTenantAudit } from '../../../api/src/modules/audit/audit.js';
import { createMessagingMembershipResolver } from '../../../api/src/modules/messaging/membership.js';
import { ensureQrChannel } from '../../../api/src/modules/messaging/qr-service.js';
import { createChatwootControlAuth } from '../../../api/src/modules/integrations/chatwoot-control-auth.js';
import { createEmbedService } from '../../../api/src/modules/integrations/embed/authorization.js';
import type { ChatwootControlService } from '../../../api/src/modules/integrations/chatwoot-control-service.js';
import type { AuthenticationContext } from '../../../api/src/http/plugins/authorization.js';

export const embedBrokerOrigin = 'https://broker.example.test', embedParentOrigin = 'https://chatwoot.example.test';
export async function createEmbedAuthFixture() {
  const adminUrl = requireTestDatabaseAdminUrl(), db = await createIsolatedPostgresDatabase(adminUrl);
  let appPool: Pool | undefined, authPool: Pool | undefined, app: ReturnType<typeof buildApp> | undefined;
  const logs: string[] = [], password = `Synthetic-${randomBytes(24).toString('base64url')}!`, email = `embed-${randomUUID()}@example.test`;
  const close = async () => {
    await app?.close(); await appPool?.end(); await authPool?.end(); await db.dispose();
    if (logs.some(line => line.includes(password) || line.includes('SYNTHETIC-PAIR-ONLY'))) throw new Error('Synthetic secret reached a log');
  };
  try {
    await withGlobalRoleLock(adminUrl, () => runMigrations(db.connectionString));
    const roleUrl = (role: string) => { const url = new URL(db.connectionString); url.username = role; url.password = ''; return url.href; };
    appPool = new Pool({ connectionString: roleUrl('jrc_app'), max: 4 }); authPool = new Pool({ connectionString: roleUrl('jrc_auth'), max: 4 });
    const transact = <T>(org: string, work: OrganizationTransaction<T>) => withOrganizationTransaction(appPool!, org, work);
    const hash = await hashPassword(password);
    const { org, otherOrg, owner, agent } = await runInAdminTransaction(db.pool, async tx => {
      const org = await createOrganization(tx, { name: 'Embed Laboratório', slug: 'embed-lab' });
      const otherOrg = await createOrganization(tx, { name: 'Outra empresa', slug: 'other-lab' });
      const owner = (await tx.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [`owner-${randomUUID()}@example.test`, hash])).rows[0].id;
      const agent = (await tx.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [email, hash])).rows[0].id;
      await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$3,'OWNER'),($2,$3,'OWNER'),($1,$4,'OPERATOR'),($2,$4,'VIEWER')", [org.id, otherOrg.id, owner, agent]);
      return { org: org.id, otherOrg: otherOrg.id, owner, agent };
    });
    const connection = await transact(org, async tx => {
      await tx.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,$2,1,'synthetic','READY')", [org, embedParentOrigin]);
      const provider = (await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic') RETURNING id", [org])).rows[0].id;
      const instance = (await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Atendimento sintético',$3,'DISCONNECTED') RETURNING *", [org, provider, randomUUID()])).rows[0];
      const channel = await ensureQrChannel(tx, org, instance.id);
      const id = (await tx.query("INSERT INTO chatwoot_connections(organization_id,channel_id,inbox_id,name,status,encrypted_webhook_secret) VALUES($1,$2,31,'Atendimento sintético','READY','synthetic') RETURNING id", [org, channel.id])).rows[0].id;
      await tx.query("INSERT INTO chatwoot_connection_health(organization_id,integration_id,channel_id,approved_fingerprint) VALUES($1,$2,$3,'synthetic-approved')", [org, id, channel.id]);
      return { id, instance: { id: instance.id, organizationId: org, providerAccountId: provider, provider: 'BAILEYS', name: instance.name,
        status: 'AWAITING_ACTION', createdAt: instance.created_at.toISOString(), updatedAt: instance.updated_at.toISOString() } };
    });
    const secret = () => randomBytes(48).toString('base64url');
    const jwtSecret = secret(), browserCsrfSecret = secret(), rateLimitStore = new MemoryRateLimitStore();
    const control = createChatwootControlAuth({ enabled: true, transact, managedOrigin: embedParentOrigin, hmacSecret: secret(), resolveCurrentRole: createMessagingMembershipResolver(authPool) });
    const service = createEmbedService({ enabled: true, pool: appPool, transact, control, managedOrigin: embedParentOrigin, rateLimitStore, rateLimitSecret: secret() });
    const principal: AuthenticationContext = { kind: 'JWT', actorId: owner, organizationId: org, role: 'OWNER' };
    await control.setOperatorGrants(principal, connection.id, { grants: [{ userId: agent, canPair: true }] }, randomUUID());
    const { embedId } = await service.apps.register(principal);
    let pairCalls = 0;
    // Only the state/pair provider facade is synthetic. Auth, CSRF, proofs, grants,
    // sessions, expiry, RLS and all HTTP routes run the actual application code.
    const facade = {
      async status() { return { integrationId: connection.id, inboxId: 31, instanceId: connection.instance.id,
        integrationStatus: 'READY', instanceStatus: 'DISCONNECTED', transportStatus: 'UNVERIFIED', checkedAt: new Date().toISOString(),
        lastError: null, identityStatus: 'CONFIRMED', identityApproved: true, identityRevision: 1, observedNumberSuffix: null,
        callbackVerifiedAt: null, lastSuccessfulInboundAt: null, lastSuccessfulOutboundAt: null, allowedActions: ['status', 'pair'] }; },
      async pair() { pairCalls++; return { instance: connection.instance, operationId: randomUUID(), pending: false, replayed: false, reconciliationRequired: false,
        action: { type: 'PAIRING_CODE', code: 'SYNTHETIC-PAIR-ONLY', expiresAt: new Date(Date.now() + 60000).toISOString() } }; },
    } as unknown as ChatwootControlService;
    const sharedAuth = { repository: createPostgresAuthRepository(authPool), rateLimitStore, writeSecurityAudit: createSecurityAuditWriter(authPool),
      writeOrganizationSelectedAudit: async (event: import('../../../api/src/modules/auth/select-organization.js').OrganizationSelectedAuditEvent) => transact(event.organizationId, tx => writeTenantAudit(tx, { type: 'ORGANIZATION_SELECTED', ...event })),
      ipRateLimitHmacSecret: secret(), identityRateLimitHmacSecret: secret(), jwtSecret, refreshTokenHashSecret: secret(), trustedProxyCidrs: [],
      rateLimit: { limit: 100, ttlMs: 60000 }, progressiveDelay: { baseDelayMs: 0, maximumDelayMs: 0 }, sleeper: async () => undefined };
    const passwordVerifier = await initializePasswordVerifier();
    app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => passwordVerifier,
      loggerDestination: new Writable({ write(chunk, _encoding, callback) { logs.push(String(chunk)); callback(); } }),
      auth: sharedAuth, consoleAuth: { ...sharedAuth, browserCsrfSecret, browserCookieSecure: true, consoleAllowedOrigins: [embedBrokerOrigin] },
      chatwootEmbed: { nodeEnv: 'test', jwtSecret, authenticateApiKey: async () => null, service, facade,
        browserCsrfSecret, browserCookieSecure: true, consoleAllowedOrigins: [embedBrokerOrigin], trustedProxyCidrs: [] } });
    const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
    return { apiOrigin, embedId, email, password, connectionId: connection.id, close,
      get pairCalls() { return pairCalls; },
      revoke: () => control.setOperatorGrants(principal, connection.id, { grants: [] }, randomUUID()),
      reset: async () => { await control.setOperatorGrants(principal, connection.id, { grants: [{ userId: agent, canPair: true }] }, randomUUID()); },
      countSessions: async () => Number((await db.pool.query('SELECT count(*) FROM chatwoot_embed_sessions')).rows[0].count),
      expireRequests: async () => { await db.pool.query("UPDATE chatwoot_embed_authorizations SET expires_at=clock_timestamp()-interval '1 second'"); },
      otherOrg,
    };
  } catch (error) { await close(); throw error; }
}
