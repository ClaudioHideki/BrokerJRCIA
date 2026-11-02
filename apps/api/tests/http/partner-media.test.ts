import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { MediaError } from '@jrc/providers';
import { buildApp } from '../../src/app.js';
import type { MessagingService } from '../../src/http/routes/messaging.js';

const org = '11111111-1111-4111-8111-111111111111';
const channel = '22222222-2222-4222-8222-222222222222';
const keyId = '33333333-3333-4333-8333-333333333333';
const mediaId = '44444444-4444-4444-8444-444444444444';
const conversationId = '55555555-5555-4555-8555-555555555555';
const jwtSecret = 'synthetic-partner-media-http-jwt-secret';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3aQAAAAASUVORK5CYII=', 'base64');
const metadata = { id: mediaId, channelId: channel, status: 'READY', kind: 'image', fileName: 'example.png', mimeType: 'image/png', byteSize: png.length, sha256: 'a'.repeat(64) };
const url = `/v1/messaging/channels/${channel}/media`;
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function harness(initialScopes: string[] = ['media:upload']) {
  let scopes = initialScopes, current = true;
  const upload = vi.fn(async () => ({ ...metadata }));
  const get = vi.fn(async () => ({ ...metadata }));
  const send = vi.fn(async () => ({ id: mediaId, conversationId, direction: 'OUTGOING', state: 'ACCEPTED', text: '', media: { id: mediaId, kind: 'image', fileName: 'example.png' } }));
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ async verifyPasswordOrDummy() { return false; } }), messaging: {
    jwtSecret, authenticateApiKey: async raw => current && raw === 'synthetic-partner-key' ? { organizationId: org, apiKeyId: keyId, scopes } : null,
    resolveCurrentRole: async () => 'OWNER',
    service: { uploadPartnerMedia: upload, getPartnerMedia: get, sendPartnerMedia: send } as unknown as MessagingService,
  } });
  apps.push(app);
  return { app, upload, get, send, revoke() { current = false; }, setScopes(value: string[]) { scopes = value; } };
}
function headers(extra: Record<string, string> = {}) {
  return { 'x-jrc-api-key': 'synthetic-partner-key', 'content-type': 'application/octet-stream',
    'x-jrc-media-mime': 'image/png', 'x-jrc-media-kind': 'image', 'x-jrc-media-name': 'example.png',
    'idempotency-key': randomUUID(), ...extra };
}

describe('partner media HTTP contract', () => {
  it('creates a durable private reference without sending a message', async () => {
    const h = harness(), requestHeaders = headers();
    const response = await h.app.inject({ method: 'POST', url, headers: requestHeaders, payload: png });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(metadata);
    expect(response.headers.location).toBe(`${url}/${mediaId}`);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(h.upload).toHaveBeenCalledWith(org, channel, { bytes: expect.any(Uint8Array), mimeType: 'image/png', kind: 'image', fileName: 'example.png', idempotencyKey: requestHeaders['idempotency-key'] }, keyId);
    expect(h.send).not.toHaveBeenCalled();
  });
  it('exposes STORING explicitly rather than asserting ready bytes', async () => {
    const h = harness(); h.upload.mockResolvedValue({ ...metadata, status: 'STORING' });
    const response = await h.app.inject({ method: 'POST', url, headers: headers(), payload: png });
    expect(response.statusCode).toBe(201); expect(response.json().status).toBe('STORING');
  });
  it.each([[], ['messaging:send'], ['media:send'], ['instances:write']].map(scopes => ({ scopes })))('refuses an upload for scopes $scopes before parsing an unsupported body', async ({ scopes }) => {
    const h = harness(scopes);
    const response = await h.app.inject({ method: 'POST', url, headers: headers({ 'content-type': 'application/x-forbidden' }), payload: png });
    expect(response.statusCode).toBe(403); expect(h.upload).not.toHaveBeenCalled();
  });
  it('rejects missing and ambiguous credentials before body parsing', async () => {
    const h = harness();
    expect((await h.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-forbidden' }, payload: png })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url, headers: headers({ authorization: 'Bearer ambiguous' }), payload: png })).statusCode).toBe(401);
    expect(h.upload).not.toHaveBeenCalled();
  });
  it('does not turn an owner JWT into a partner upload credential', async () => {
    const h = harness(), token = await issueAccessToken({ userId: keyId, organizationId: org, role: 'OWNER' }, jwtSecret);
    const requestHeaders = headers(); delete (requestHeaders as Record<string, string>)['x-jrc-api-key'];
    const response = await h.app.inject({ method: 'POST', url, headers: { ...requestHeaders, authorization: `Bearer ${token}` }, payload: png });
    expect(response.statusCode).toBe(403); expect(h.upload).not.toHaveBeenCalled();
  });
  it.each([
    { extra: { 'content-type': 'application/json' }, payload: Buffer.from('{}'), status: 415 },
    { extra: { 'x-jrc-media-name': '%broken' }, payload: png, status: 400 },
    { extra: { 'x-jrc-media-kind': 'sticker' }, payload: png, status: 400 },
    { extra: {}, payload: Buffer.alloc(0), status: 400 },
  ])('rejects invalid binary headers/body without calling storage: $status', async ({ extra, payload, status }) => {
    const h = harness();
    const response = await h.app.inject({ method: 'POST', url, headers: headers(extra as Record<string, string>), payload });
    expect(response.statusCode).toBe(status); expect(h.upload).not.toHaveBeenCalled();
  });
  it('rejects tenant override and an oversized upload before storage', async () => {
    const h = harness();
    expect((await h.app.inject({ method: 'POST', url: `${url}?organizationId=${org}`, headers: headers(), payload: png })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url, headers: headers(), payload: Buffer.alloc(16 * 1024 * 1024 + 1) })).statusCode).toBe(413);
    expect(h.upload).not.toHaveBeenCalled();
  });
  it('withholds metadata and location if the key is revoked during upload', async () => {
    const h = harness(); h.upload.mockImplementation(async () => { h.revoke(); return metadata; });
    const response = await h.app.inject({ method: 'POST', url, headers: headers(), payload: png });
    expect(response.statusCode).toBe(401); expect(response.headers.location).toBeUndefined(); expect(response.body).not.toContain(metadata.sha256);
  });
  it('returns an idempotency conflict as 409 without exposing storage metadata', async () => {
    const h = harness(); h.upload.mockRejectedValue(new MediaError('MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT'));
    const response = await h.app.inject({ method: 'POST', url, headers: headers(), payload: png });
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe('MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT');
    expect(response.headers.location).toBeUndefined(); expect(response.body).not.toContain(metadata.sha256);
  });
  it('GET observes the reference without creating or sending anything', async () => {
    const h = harness();
    const response = await h.app.inject({ url: `${url}/${mediaId}`, headers: { 'x-jrc-api-key': 'synthetic-partner-key' } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(metadata);
    expect(h.get).toHaveBeenCalledWith(org, channel, mediaId, keyId);
    expect(h.upload).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it('rechecks the current upload scope after reading metadata', async () => {
    const h = harness(); h.get.mockImplementation(async () => { h.setScopes(['messaging:read']); return metadata; });
    const response = await h.app.inject({ url: `${url}/${mediaId}`, headers: { 'x-jrc-api-key': 'synthetic-partner-key' } });
    expect(response.statusCode).toBe(403); expect(response.body).not.toContain(metadata.sha256);
  });
  it.each([['messaging:send'], ['media:send'], ['media:upload']].map(scopes => ({ scopes })))('requires both sending scopes, current $scopes', async ({ scopes }) => {
    const h = harness(scopes);
    const response = await h.app.inject({ method: 'POST', url: `${url.replace(/\/media$/, '')}/partner-media`, headers: { 'x-jrc-api-key': 'synthetic-partner-key', 'idempotency-key': randomUUID() }, payload: { conversationId, mediaId, caption: 'Example' } });
    expect(response.statusCode).toBe(403); expect(h.send).not.toHaveBeenCalled();
  });
  it('admits one canonical media intent with both scopes and a strict recipient', async () => {
    const h = harness(['messaging:send', 'media:send']), idempotencyKey = randomUUID(), sendUrl = `${url.replace(/\/media$/, '')}/partner-media`;
    const input = { conversationId, mediaId, caption: 'Example' };
    const response = await h.app.inject({ method: 'POST', url: sendUrl, headers: { 'x-jrc-api-key': 'synthetic-partner-key', 'idempotency-key': idempotencyKey }, payload: input });
    expect(response.statusCode).toBe(202); expect(response.json().state).toBe('ACCEPTED');
    expect(h.send).toHaveBeenCalledWith(org, channel, input, idempotencyKey, keyId);
    const invalid = await h.app.inject({ method: 'POST', url: sendUrl, headers: { 'x-jrc-api-key': 'synthetic-partner-key', 'idempotency-key': randomUUID() }, payload: { ...input, phoneNumber: '+15555550100' } });
    expect(invalid.statusCode).toBe(400); expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('identifies an upload that is not ready without admitting or repeating a physical send', async () => {
    const h = harness(['messaging:send', 'media:send']);
    h.send.mockRejectedValue(Object.assign(new Error('MEDIA_NOT_READY'), { code: 'MEDIA_NOT_READY', status: 409 }));
    const response = await h.app.inject({ method: 'POST', url: `${url.replace(/\/media$/, '')}/partner-media`,
      headers: { 'x-jrc-api-key': 'synthetic-partner-key', 'idempotency-key': randomUUID() }, payload: { conversationId, mediaId } });
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe('MEDIA_NOT_READY');
    expect(h.send).toHaveBeenCalledOnce(); expect(h.upload).not.toHaveBeenCalled();
  });
});
