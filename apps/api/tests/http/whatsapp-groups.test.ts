import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { WhatsAppGroupCatalogPageSchema } from '@jrc/contracts';
import type { Role } from '../../src/http/plugins/authorization.js';
import { registerWhatsAppGroupsRoutes } from '../../src/http/routes/whatsapp-groups.js';
import { GroupCatalogError } from '../../src/modules/whatsapp-groups/service.js';
import { TenantOperationalError } from '../../src/modules/tenancy/operational-limits.js';

const org = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const channel = '33333333-3333-4333-8333-333333333333';
const snapshotId = '44444444-4444-4444-8444-444444444444';
const groupJid = '120000000000001@g.us';
const secret = 'g1-route-synthetic-jwt-secret-32-bytes';
const url = `/v1/channels/${channel}/whatsapp-groups`;
const cursor = { snapshotId, afterGroupJid: groupJid };
const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const selection = {
  expectedSnapshotId: snapshotId, expectedCatalogRevision: 1, expectedIdentityRevision: 1,
  expectedIdentityFingerprint: 'a'.repeat(64), groupJid, enabled: true,
};
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function catalogPage() {
  return WhatsAppGroupCatalogPageSchema.parse({
    snapshot: {
      schemaVersion: 1, scope: { provider: 'QR', organizationId: org, channelId: channel,
        identityRevision: 1, identityFingerprint: 'a'.repeat(64) },
      snapshotId, catalogRevision: 1, observedAt: '2026-10-08T12:00:00.000Z', status: 'CURRENT',
      lastAttemptAt: '2026-10-08T12:00:00.000Z', lastErrorCode: null,
    },
    items: [{ groupJid, subject: 'Synthetic group', participantCount: 3,
      restrict: null, announce: false, isCommunity: null, isCommunityAnnounce: null, linkedParent: null }],
    total: 1, nextCursor: null,
  });
}

async function harness() {
  let role: Role | null = 'OWNER';
  const page = catalogPage();
  const service = {
    page: vi.fn().mockResolvedValue(page), refresh: vi.fn().mockResolvedValue(page),
    select: vi.fn().mockResolvedValue(page),
  };
  const resolveCurrentRole = vi.fn(async () => role);
  const configuration={ensure:vi.fn(),status:vi.fn().mockResolvedValue({schemaVersion:1,organizationId:org,channelId:channel,
    status:'UNKNOWN',operationId:snapshotId,configurationRevision:2,observedAt:null,updatedAt:'2026-10-08T11:00:00.000Z',
    observedIdentityRevision:1,observedCatalogRevision:1,safeError:'CONFIGURATION_UNKNOWN',nextAction:'RECONCILE_READ_ONLY'})};
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  apps.push(app);
  await app.register(async scope => registerWhatsAppGroupsRoutes(scope, {
    jwtSecret: secret, service, resolveCurrentRole,configuration,
    authenticateApiKey: async (raw: string) => raw === 'synthetic-current-key'
      ? { organizationId: org, apiKeyId: channel, scopes: ['*'] } : null,
  }));
  return { app, service, page, configuration,resolveCurrentRole, setRole: (value: Role | null) => { role = value; },
    headers: { authorization: `Bearer ${await issueAccessToken({ userId: actor, organizationId: org, role: 'OWNER' }, secret)}` } };
}

describe('WhatsApp group catalog HTTP boundary (G1)', () => {
  it('reports configuration separately with the same current operator grant and never allows scope in the request',async()=>{
    const h=await harness(),statusUrl=`/v1/channels/${channel}/whatsapp-group-events-configuration`;
    h.setRole('OPERATOR');const response=await h.app.inject({url:statusUrl,headers:h.headers});
    expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({status:'UNKNOWN',nextAction:'RECONCILE_READ_ONLY'});
    expect(response.headers['cache-control']).toBe('no-store');expect(h.configuration.ensure).not.toHaveBeenCalled();
    expect((await h.app.inject({url:`${statusUrl}?organizationId=${org}`,headers:h.headers})).statusCode).toBe(400);
    h.setRole(null);expect((await h.app.inject({url:statusUrl,headers:h.headers})).statusCode).toBe(403);
    expect(h.configuration.status).toHaveBeenCalledTimes(1);
  });
  it('rejects provider credentials in configuration responses and exposes the safe rollout error',async()=>{
    const h=await harness(),statusUrl=`/v1/channels/${channel}/whatsapp-group-events-configuration`;
    h.configuration.status.mockResolvedValueOnce({...await h.configuration.status(),engineKey:'private-canary'});
    const response=await h.app.inject({url:statusUrl,headers:h.headers});expect(response.statusCode).toBe(500);expect(response.body).not.toContain('private-canary');
    h.service.refresh.mockRejectedValueOnce(new GroupCatalogError('GROUP_WEBHOOK_UNKNOWN'));
    const unknown=await h.app.inject({method:'POST',url:`${url}/refresh`,headers:h.headers,payload:{}});
    expect(unknown.statusCode).toBe(409);expect(unknown.json()).toMatchObject({code:'GROUP_WEBHOOK_UNKNOWN'});
  });
  it('reads only the JWT principal with local default pagination and no-store', async () => {
    const h = await harness(), response = await h.app.inject({ url, headers: h.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(h.page);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(h.resolveCurrentRole).toHaveBeenCalledWith(actor, org);
    expect(h.service.page).toHaveBeenCalledWith({ organizationId: org, actorId: actor }, channel, { limit: 50 });
  });

  it('decodes a canonical opaque cursor and coerces the local numeric limit', async () => {
    const h = await harness();
    const response = await h.app.inject({ url: `${url}?limit=100&cursor=${encodeCursor(cursor)}`, headers: h.headers });
    expect(response.statusCode).toBe(200);
    expect(h.service.page).toHaveBeenCalledWith({ organizationId: org, actorId: actor }, channel, { limit: 100, cursor });
  });

  it.each(['OWNER', 'ADMIN', 'OPERATOR'] as const)('permits catalog GET for current %s membership', async role => {
    const h = await harness(); h.setRole(role);
    expect((await h.app.inject({ url, headers: h.headers })).statusCode).toBe(200);
  });

  it.each(['OWNER', 'ADMIN'] as const)('permits refresh and explicit selection for current %s membership', async role => {
    const h = await harness(); h.setRole(role);
    const refreshed = await h.app.inject({ method: 'POST', url: `${url}/refresh`, headers: h.headers, payload: {} });
    const selected = await h.app.inject({ method: 'PUT', url: `${url}/selection`, headers: h.headers, payload: selection });
    expect(refreshed.statusCode).toBe(200); expect(selected.statusCode).toBe(200);
    expect(refreshed.headers['cache-control']).toBe('no-store'); expect(selected.headers['cache-control']).toBe('no-store');
    expect(selected.json()).toEqual(h.page);
    expect(h.service.refresh).toHaveBeenCalledWith({ organizationId: org, actorId: actor }, channel);
    expect(h.service.select).toHaveBeenCalledWith({ organizationId: org, actorId: actor }, channel, selection);
  });

  it('rechecks role for every request rather than trusting the OWNER role in an older token', async () => {
    const h = await harness(); h.setRole('OPERATOR');
    expect((await h.app.inject({ url, headers: h.headers })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: `${url}/refresh`, headers: h.headers, payload: {} })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'PUT', url: `${url}/selection`, headers: h.headers, payload: selection })).statusCode).toBe(403);
    h.setRole(null);
    expect((await h.app.inject({ url, headers: h.headers })).statusCode).toBe(403);
    h.setRole('VIEWER');
    expect((await h.app.inject({ url, headers: h.headers })).statusCode).toBe(403);
    expect(h.resolveCurrentRole).toHaveBeenCalledTimes(5);
    expect(h.service.refresh).not.toHaveBeenCalled(); expect(h.service.select).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST', 'PUT'] as const)('rejects missing/invalid credentials and API keys before %s dispatch', async method => {
    const h = await harness(), target = method === 'GET' ? url : `${url}/${method === 'POST' ? 'refresh' : 'selection'}`;
    const body = method === 'GET' ? {} : { payload: method === 'POST' ? {} : selection };
    for (const headers of [{}, { authorization: 'Bearer invalid-synthetic-token' },
      { ...h.headers, 'x-jrc-api-key': 'synthetic-current-key' }]) {
      const response = await h.app.inject({ method, url: target, headers, ...body });
      expect(response.statusCode).toBe(401); expect(response.headers['cache-control']).toBe('no-store');
    }
    const apiKey = await h.app.inject({ method, url: target, headers: { 'x-jrc-api-key': 'synthetic-current-key' }, ...body });
    expect(apiKey.statusCode).toBe(403); expect(apiKey.headers['cache-control']).toBe('no-store');
    expect(h.service.page).not.toHaveBeenCalled(); expect(h.service.refresh).not.toHaveBeenCalled(); expect(h.service.select).not.toHaveBeenCalled();
    expect(h.resolveCurrentRole).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '101', '1.5', 'NaN', ''])('rejects out-of-range or malformed local limit %j', async limit => {
    const h = await harness(), response = await h.app.inject({ url: `${url}?limit=${limit}`, headers: h.headers });
    expect(response.statusCode).toBe(400); expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST', requestId: expect.any(String) });
    expect(h.service.page).not.toHaveBeenCalled();
  });

  it.each(['!invalid!', '', 'a'.repeat(1025), Buffer.from('not-json').toString('base64url'),
    encodeCursor({ snapshotId }), encodeCursor({ ...cursor, afterGroupJid: 'synthetic@lid' }),
    encodeCursor({ ...cursor, organizationId: org }), `${encodeCursor(cursor)}=`])(
    'rejects a malformed, oversized or scope-bearing opaque cursor (%#)', async invalidCursor => {
      const h = await harness(), response = await h.app.inject({ url: `${url}?cursor=${invalidCursor}`, headers: h.headers });
      expect(response.statusCode).toBe(400); expect(response.headers['cache-control']).toBe('no-store');
      expect(h.service.page).not.toHaveBeenCalled();
    },
  );

  it('rejects foreign authority fields, refresh content and write query parameters', async () => {
    const h = await harness();
    const cases = [
      { method: 'GET' as const, url: `${url}?organizationId=${snapshotId}` },
      { method: 'GET' as const, url: '/v1/channels/not-a-uuid/whatsapp-groups' },
      { method: 'POST' as const, url: `${url}/refresh`, payload: { organizationId: snapshotId } },
      { method: 'POST' as const, url: `${url}/refresh?limit=50`, payload: {} },
      { method: 'POST' as const, url: `${url}/refresh`, payload: { getParticipants: true } },
      { method: 'PUT' as const, url: `${url}/selection`, payload: { ...selection, actorId: snapshotId } },
      { method: 'PUT' as const, url: `${url}/selection`, payload: { ...selection, send: true } },
      { method: 'PUT' as const, url: `${url}/selection?organizationId=${snapshotId}`, payload: selection },
      { method: 'PUT' as const, url: `${url}/selection`, payload: { ...selection, expectedIdentityFingerprint: 'raw-private-identity' } },
    ];
    for (const input of cases) {
      const response = await h.app.inject({ ...input, headers: h.headers });
      expect(response.statusCode).toBe(400); expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(h.service.page).not.toHaveBeenCalled(); expect(h.service.refresh).not.toHaveBeenCalled(); expect(h.service.select).not.toHaveBeenCalled();
  });

  it('returns known channel/conflict/provider problems without raw credentials or diagnostics', async () => {
    const h = await harness();
    for (const [code, status] of [['GROUP_CHANNEL_NOT_FOUND', 404], ['GROUP_CATALOG_CHANGED', 409], ['PROVIDER_TIMEOUT', 502]] as const) {
      h.service.page.mockRejectedValueOnce(new GroupCatalogError(code, status));
      const response = await h.app.inject({ url, headers: h.headers });
      expect(response.statusCode).toBe(status); expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.headers['cache-control']).toBe('no-store'); expect(response.json()).toEqual({ type: 'about:blank', title: code, status, code, requestId: expect.any(String) });
    }
  });

  it('preserves the existing tenant operational problem mapping', async () => {
    const h = await harness(); h.service.refresh.mockRejectedValueOnce(new TenantOperationalError());
    const response = await h.app.inject({ method: 'POST', url: `${url}/refresh`, headers: h.headers, payload: {} });
    expect(response.statusCode).toBe(403); expect(response.json()).toMatchObject({ code: 'ORGANIZATION_NOT_ACTIVE' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('hides unexpected provider details, unrecognized domain codes and unsafe status values', async () => {
    const h = await harness();
    for (const error of [new Error('synthetic-private-provider-token'),
      new GroupCatalogError('SYNTHETIC_PRIVATE_TOKEN'), new GroupCatalogError('GROUP_CATALOG_CHANGED', 200),
      Object.assign(new Error('synthetic-private-provider-token'), { code: 'PROVIDER_TIMEOUT', status: 502 })]) {
      h.service.page.mockRejectedValueOnce(error);
      const response = await h.app.inject({ url, headers: h.headers });
      expect(response.statusCode).toBe(500); expect(response.json()).toMatchObject({ code: 'GROUP_CATALOG_UNAVAILABLE' });
      expect(response.body).not.toMatch(/synthetic-private-provider-token|SYNTHETIC_PRIVATE_TOKEN/);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('fails closed when a service result violates the strict public response contract', async () => {
    const h = await harness(); h.service.page.mockResolvedValueOnce({ ...h.page, apiKey: 'synthetic-private-provider-token' });
    const response = await h.app.inject({ url, headers: h.headers });
    expect(response.statusCode).toBe(500); expect(response.json()).toMatchObject({ code: 'GROUP_CATALOG_UNAVAILABLE' });
    expect(response.body).not.toContain('synthetic-private-provider-token'); expect(response.headers['cache-control']).toBe('no-store');
  });
});
