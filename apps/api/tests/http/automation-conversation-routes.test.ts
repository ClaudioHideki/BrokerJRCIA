import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { MediaError } from '@jrc/providers';
import { registerAutomationRoutes } from '../../src/http/routes/automations.js';
import { registerFlowDelegationRoutes } from '../../src/http/routes/flow-delegation.js';

const org = randomUUID(), actor = randomUUID(), root = randomUUID(), channel = randomUUID(), assetId = randomUUID();
const secret = 'synthetic-route-test-secret-more-than-32', token = 't'.repeat(43);
const scope = { organizationId: org, rootAutomationId: root, channelId: channel };
const capability = { state: 'SUPPORTED', reason: null };
const asset = { schemaVersion: 1, scope, id: assetId, revision: 1, status: 'READY', name: 'teste.txt',
  kind: 'document', mimeType: 'text/plain', byteSize: 5 };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function harness(delegated: boolean) {
  const app = Fastify(); apps.push(app); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  let role: 'OWNER' | null = 'OWNER';
  const service = {
    resourceChannels: vi.fn(async () => ({ schemaVersion: 1, scope: { organizationId: org, rootAutomationId: root },
      data: [{ id: channel, name: 'Atendimento' }], nextCursor: null })),
    actionCatalog: vi.fn(async () => ({ schemaVersion: 1, scope, profile: 'STANDALONE', data: [], nextCursor: null,
      capabilities: { tag: capability, attribute: capability, note: capability, resolve: capability, media: capability } })),
    saveActionResource: vi.fn(async () => ({ id: assetId })), mediaCatalog: vi.fn(async () => ({ schemaVersion: 1, scope, data: [asset] })),
    uploadMedia: vi.fn(async () => asset), revokeMedia: vi.fn(async () => ({ ok: true })),
  };
  const auth = { jwtSecret: secret, authenticateApiKey: async () => null, resolveCurrentRole: async () => role };
  if (delegated) await app.register(async target => registerFlowDelegationRoutes(target, {
    ...auth, resolveFlowSession: async () => org, service: service as never,
  }));
  else await app.register(async target => registerAutomationRoutes(target, { ...auth, service: service as never, executions: {} as never }));
  const headers = { authorization: `Bearer ${delegated ? token : await issueAccessToken({ organizationId: org, userId: actor,
    role: 'OWNER', authVersion: 1 }, secret)}` };
  return { app, service, headers, prefix: delegated ? '/v1/delegated-flows' : '/v1/automations',
    access: delegated ? { organizationId: org, token } : org, revoke: () => { role = null; } };
}

describe.each([false, true])('action resource routes, delegated=%s', delegated => {
  it('forwards scoped root/channel catalogs and refuses an injected organization', async () => {
    const h = await harness(delegated), base = `${h.prefix}/${root}`;
    for (const suffix of ['/resource-channels', `/channels/${channel}/action-catalog`, `/channels/${channel}/media`]) {
      expect((await h.app.inject({ url: base + suffix, headers: h.headers })).statusCode).toBe(200);
      expect((await h.app.inject({ url: base + suffix + '?organizationId=' + randomUUID(), headers: h.headers })).statusCode).toBe(400);
    }
    expect(h.service.resourceChannels).toHaveBeenCalledWith(h.access, root, expect.any(Object));
    expect(h.service.actionCatalog).toHaveBeenCalledWith(h.access, root, channel, expect.any(Object));
    expect(h.service.mediaCatalog).toHaveBeenCalledWith(h.access, root, channel);
  });

  it('accepts typed local resources and requires the current media revision for revocation', async () => {
    const h = await harness(delegated), base = `${h.prefix}/${root}/channels/${channel}`;
    const input = { name: 'Ativo', key: 'active', kind: 'ATTRIBUTE', definition: {
      valueType: 'boolean', maxLength: 8, allowedValues: [] }, status: 'ACTIVE' };
    expect((await h.app.inject({ method: 'POST', url: base + '/action-resources', headers: h.headers, payload: input })).statusCode).toBe(200);
    expect(h.service.saveActionResource).toHaveBeenCalledWith(h.access, root, channel, input);
    expect((await h.app.inject({ method: 'POST', url: `${base}/media/${assetId}/revoke`, headers: h.headers, payload: {} })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url: `${base}/media/${assetId}/revoke`, headers: h.headers, payload: { revision: 1 } })).statusCode).toBe(200);
    expect(h.service.revokeMedia).toHaveBeenCalledWith(h.access, root, channel, assetId, 1);
  });

  it('uses a bounded binary upload instead of a graph JSON payload', async () => {
    const h = await harness(delegated), key = randomUUID(), url = `${h.prefix}/${root}/channels/${channel}/media`;
    const headers = { ...h.headers, 'content-type': 'application/octet-stream', 'x-jrc-media-mime': 'text/plain',
      'x-jrc-media-kind': 'document', 'x-jrc-media-name': encodeURIComponent('teste.txt'), 'idempotency-key': key };
    expect((await h.app.inject({ method: 'POST', url, headers, payload: Buffer.from('teste') })).statusCode).toBe(201);
    expect(h.service.uploadMedia).toHaveBeenCalledWith(h.access, root, channel, { bytes: expect.any(Uint8Array),
      mimeType: 'text/plain', kind: 'document', fileName: 'teste.txt', idempotencyKey: key });
    expect((await h.app.inject({ method: 'POST', url, headers: h.headers, payload: { bytes: 'dGVzdGU=' } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url, headers, payload: Buffer.alloc(16777217) })).statusCode).toBe(413);
    expect(h.service.uploadMedia).toHaveBeenCalledTimes(1);
  });
});

it('rechecks the current console role after an upload and maps private storage limits explicitly', async () => {
  const h = await harness(false), url = `${h.prefix}/${root}/channels/${channel}/media`;
  const headers = { ...h.headers, 'content-type': 'application/octet-stream', 'x-jrc-media-mime': 'text/plain',
    'x-jrc-media-kind': 'document', 'x-jrc-media-name': 'teste.txt', 'idempotency-key': randomUUID() };
  h.service.uploadMedia.mockImplementationOnce(async () => { h.revoke(); return asset; });
  expect((await h.app.inject({ method: 'POST', url, headers, payload: Buffer.from('teste') })).statusCode).toBe(403);
  const next = await harness(false);
  next.service.uploadMedia.mockRejectedValueOnce(new MediaError('MEDIA_SIZE_LIMIT'));
  expect((await next.app.inject({ method: 'POST', url, headers: { ...headers, ...next.headers }, payload: Buffer.from('teste') })).statusCode).toBe(413);
});
