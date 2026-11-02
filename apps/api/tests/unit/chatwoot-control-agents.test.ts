import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { ControlAgentsSchema } from '@jrc/contracts';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';
import { createChatwootService, type ChatwootOptions } from '../../src/modules/integrations/chatwoot-service.js';
import { createChatwootControlService, type ChatwootControlOptions } from '../../src/modules/integrations/chatwoot-control-service.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import { IntegrationError } from '../../src/modules/integrations/integration-error.js';
import type { ChatwootControlPrincipal } from '../../src/modules/integrations/chatwoot-control-auth.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import { createOnboardingService, type OnboardingOptions } from '../../src/modules/integrations/chatwoot-onboarding.js';
import { registerPlatformRoutes } from '../../src/http/routes/platform.js';
import { PlatformError, type PlatformService } from '../../src/modules/platform/service.js';

function harness() {
  const org = randomUUID(), integration = randomUUID(), channel = randomUUID(), actor = randomUUID();
  const origin = 'https://chatwoot.example.test', broker = 'https://broker.example.test';
  const vault = createIntegrationSecrets(Buffer.alloc(32, 7).toString('base64'));
  const destination = { organizationId: org, baseUrl: origin, mode: 'MANAGED', approvalStatus: 'APPROVED', revision: 1, mediaOrigins: [] };
  const account = { organization_id: org, base_url: origin, account_id: '7', credential_version: 1,
    encrypted_token: vault.encrypt(`${org}:chatwoot-account`, 'synthetic-token'), status: 'READY', last_error: null };
  const connection = { id: integration, organization_id: org, channel_id: channel, instance_id: randomUUID(),
    inbox_id: '31', name: 'Synthetic inbox', status: 'READY', last_error: null,
    encrypted_webhook_secret: vault.encrypt(`${org}:chatwoot-webhook:${integration}`, 'synthetic-secret') };
  let permitted = true, assigned = [1], completed = false;
  let duringAgents: (() => void) | undefined, rejectAgents = false, ignoreReplacement = false;
  const mutations: { method: string; ids: number[] }[] = [];
  const principal = { organizationId: org, accountId: 7, destinationRevision: 1, chatwootOrigin: origin,
    authentication: { kind: 'JWT', organizationId: org, actorId: actor, role: 'OWNER' } } as ChatwootControlPrincipal;
  const query = vi.fn(async (sql: string) => {
    const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
    if (sql.includes('FROM chatwoot_destinations')) return result([{ ...destination }]);
    if (sql.includes('FROM chatwoot_accounts WHERE')) return result([{ ...account }]);
    if (sql.includes('FROM chatwoot_connections')) return result([{ ...connection }]);
    if (sql.includes('tenant_is_active')) return result([{ active: true }]);
    if (sql.includes('INSERT INTO idempotency_records')) return result([{ id: randomUUID() }]);
    if (sql.includes('UPDATE idempotency_records')) { completed = true; return result(); }
    if (sql.includes('DELETE FROM idempotency_records') || sql.includes('UPDATE chatwoot_accounts')
      || sql.includes('INSERT INTO chatwoot_connection_health') || sql.includes('INSERT INTO integration_audit')) return result();
    throw Error(`Unexpected synthetic SQL: ${sql}`);
  });
  const transact = async <T>(_org: string, work: (tx: TenantTransaction) => Promise<T>) => work({ query } as unknown as TenantTransaction);
  const auth = {
    enabled: true,
    async revalidate() { if (!permitted) throw new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403); },
    audit: vi.fn().mockResolvedValue(undefined),
  };
  const users = [1, 2].map(id => ({ id, name: `Synthetic agent ${id}`, email: `agent${id}@example.test` }));
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/profile')) return Response.json({ accounts: [{ id: 7, role: 'administrator' }] });
    if (path.endsWith('/inboxes/31')) return Response.json({ id: 31, name: 'Synthetic inbox', channel_type: 'Channel::Api',
      webhook_url: `${broker}/v1/integrations/chatwoot/${integration}/events`, secret: 'synthetic-secret' });
    if (path.endsWith('/agents')) {
      duringAgents?.();
      return rejectAgents ? Response.json({}, { status: 403 }) : Response.json(users);
    }
    if (path.endsWith('/inbox_members/31')) return Response.json({ payload: users.filter(user => assigned.includes(user.id)) });
    if (path.endsWith('/inbox_members') && ['POST', 'PATCH'].includes(init?.method ?? '')) {
      const ids = (JSON.parse(String(init?.body)) as { user_ids: number[] }).user_ids;
      mutations.push({ method: init!.method!, ids });
      // Chatwoot create adds; its collection PATCH update replaces the set.
      if (init!.method === 'PATCH') { if (!ignoreReplacement) assigned = [...ids]; }
      else assigned = [...new Set([...assigned, ...ids])];
      return Response.json({ payload: users.filter(user => assigned.includes(user.id)) });
    }
    throw Error(`Unexpected synthetic HTTP: ${path}`);
  });
  const options: ChatwootOptions = { baseUrl: origin, publicOrigin: broker, encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    transact, fetch, resolveIntegration: async () => org };
  const chatwoot = createChatwootService(options);
  const control = createChatwootControlService({ ...options, auth, chatwoot } as unknown as ChatwootControlOptions);
  return { org, integration, actor, channel, principal, chatwoot, control, auth, mutations, query,
    permitted: () => permitted,
    assigned: () => assigned, completed: () => completed,
    duringAgents: (action: () => void) => { duringAgents = action; },
    revoke: () => { permitted = false; }, rotateCredential: () => { account.credential_version++; },
    disableBinding: () => { connection.status = 'DISABLED'; }, rejectAgents: () => { rejectAgents = true; },
    ignoreReplacement: () => { ignoreReplacement = true; } };
}

it.each([{ ids: [] }, { ids: [2] }])('PUT control agents replaces the remote set with $ids, including removal', async ({ ids }) => {
  const h = harness();
  expect(ControlAgentsSchema.parse({ agentIds: ids })).toEqual({ agentIds: ids });
  await expect(h.control.agents(h.principal, h.integration, ids, randomUUID())).resolves.toEqual({ ok: true });
  expect(h.assigned()).toEqual(ids);
  expect(h.mutations).toEqual([{ method: 'PATCH', ids }]);
  expect(h.completed()).toBe(true);
});

it('does not mutate agents or complete the intent when the catalog GET fails', async () => {
  const h = harness(); h.rejectAgents();
  await expect(h.control.agents(h.principal, h.integration, [2], randomUUID())).rejects.toThrow();
  expect(h.mutations).toEqual([]); expect(h.assigned()).toEqual([1]); expect(h.completed()).toBe(false);
});

it('does not report a completed replacement when the remote readback still has the old set', async () => {
  const h = harness(); h.ignoreReplacement();
  await expect(h.control.agents(h.principal, h.integration, [], randomUUID()))
    .rejects.toMatchObject({ code: 'CHATWOOT_AGENTS_RECONCILIATION_REQUIRED', status: 409 });
  expect(h.mutations).toEqual([{ method: 'PATCH', ids: [] }]); expect(h.completed()).toBe(false);
});

it('rechecks control permission after the catalog GET and before changing agents', async () => {
  const h = harness(); h.duringAgents(h.revoke);
  await expect(h.control.agents(h.principal, h.integration, [2], randomUUID())).rejects.toMatchObject({ status: 403 });
  expect(h.mutations).toEqual([]); expect(h.assigned()).toEqual([1]); expect(h.completed()).toBe(false);
});

it.each(['credential', 'binding'] as const)('does not mutate a %s snapshot changed during the catalog GET', async change => {
  const h = harness(); h.duringAgents(change === 'credential' ? h.rotateCredential : h.disableBinding);
  await expect(h.control.agents(h.principal, h.integration, [2], randomUUID())).rejects.toMatchObject({ status: 409 });
  expect(h.mutations).toEqual([]); expect(h.completed()).toBe(false);
});

it('preserves additive POST behavior for the existing onboarding/legacy service', async () => {
  const h = harness();
  await h.chatwoot.addAgents(h.org, h.integration, [2], h.actor);
  expect(h.assigned()).toEqual([1, 2]); expect(h.mutations).toEqual([{ method: 'POST', ids: [2] }]);
});

it('honors the caller revocation fence on additive assignment after the catalog GET', async () => {
  const h = harness(); h.duringAgents(h.revoke);
  const add = h.chatwoot.addAgents.bind(h.chatwoot) as unknown as (org: string, id: string, ids: number[], actor: string,
    beforeMutation: (tx: TenantTransaction) => Promise<void>) => Promise<unknown>;
  await expect(add(h.org, h.integration, [2], h.actor, () => h.auth.revalidate())).rejects.toMatchObject({ status: 403 });
  expect(h.mutations).toEqual([]); expect(h.assigned()).toEqual([1]);
});

it('the legacy HTTP assignment checks current membership after the remote catalog GET', async () => {
  const h = harness(), secret = 'synthetic-agents-jwt-secret-at-least-32';
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ async verifyPasswordOrDummy() { return false; } }),
    integrations: { jwtSecret: secret, authenticateApiKey: async () => null,
      resolveCurrentRole: async () => h.permitted() ? 'OWNER' : null, service: h.chatwoot } });
  const token = await issueAccessToken({ userId: h.actor, organizationId: h.org, role: 'OWNER' }, secret);
  h.duringAgents(h.revoke);
  try {
    const response = await app.inject({ method: 'POST', url: `/v1/integrations/chatwoot/connections/${h.integration}/agents`,
      headers: { authorization: `Bearer ${token}` }, payload: { userIds: [2] } });
    expect(response.statusCode).toBe(403); expect(h.mutations).toEqual([]); expect(h.assigned()).toEqual([1]);
  } finally { await app.close(); }
});

it('onboarding rechecks its lease and actor during the assignment catalog GET before POST', async () => {
  const h = harness(), operationId = randomUUID(), lease = randomUUID();
  let catalogGets = 0;
  h.duringAgents(() => { if (++catalogGets === 2) h.revoke(); });
  const row = { id: operationId, organization_id: h.org, account_id: '7', destination_revision: 1,
    chatwoot_origin: h.principal.chatwootOrigin, actor_id: h.actor, actor_api_key_id: null, external_actor_id: null,
    state: 'RUNNING', stage: 'ASSIGN_AGENTS', lease_token: lease, reconcile_only: false, retry_requested: false, cancel_requested: false,
    instance_id: randomUUID(), channel_id: h.channel, integration_id: h.integration, inbox_id: '31',
    input: { name: 'Synthetic onboarding', source: { kind: 'EXISTING', instanceId: randomUUID() }, agentIds: [2], replaceExistingWebhook: false } };
  const query = async (sql: string) => {
    if (sql.includes('UPDATE chatwoot_onboarding_operations SET state=\'RUNNING\'')) return { rows: [row], rowCount: 1 };
    if (sql.includes('SELECT 1 FROM chatwoot_onboarding_operations')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('chatwoot_onboarding_operations')) return { rows: [], rowCount: 0 };
    return h.query(sql);
  };
  const onboarding = createOnboardingService({ transact: async (_org: string, work: (tx: TenantTransaction) => Promise<unknown>) => work({ query } as unknown as TenantTransaction),
    auth: { ...h.auth, delegate: () => ({ credentialKind: 'CHATWOOT_CONTROL' }) }, chatwoot: h.chatwoot } as unknown as OnboardingOptions);
  await onboarding.runOnce(h.org);
  expect(catalogGets).toBeGreaterThanOrEqual(2); expect(h.mutations).toEqual([]); expect(h.assigned()).toEqual([1]);
});

it.each(['session', 'role'] as const)('platform assignment rechecks its %s after the remote catalog GET without repeating the audit', async change => {
  const h = harness(); let revoked = false;
  const authorizeIntegration = vi.fn().mockResolvedValue(h.actor);
  const service = { authorizeIntegration, async session() {
    if (revoked && change === 'session') throw new PlatformError(401, 'PLATFORM_INVALID_SESSION');
    return { csrfToken: 'synthetic-csrf', user: { id: h.actor, role: revoked ? 'SUPPORT' : 'SUPER_ADMIN' } };
  } } as unknown as PlatformService;
  h.duringAgents(() => { revoked = true; });
  const app = Fastify();
  await registerPlatformRoutes(app, { service, chatwoot: h.chatwoot, origin: 'https://console.example.test', secureCookies: true });
  try {
    const response = await app.inject({ method: 'POST', url: `/v1/platform/organizations/${h.org}/chatwoot/connections/${h.integration}/agents`,
      headers: { origin: 'https://console.example.test', cookie: `platform_session=${'a'.repeat(43)}`,
        'x-csrf-token': 'synthetic-csrf', 'x-platform-reason': 'Synthetic agent assignment' }, payload: { userIds: [2] } });
    expect(response.statusCode).toBe(change === 'session' ? 401 : 403);
    expect(h.mutations).toEqual([]); expect(h.assigned()).toEqual([1]); expect(authorizeIntegration).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});
