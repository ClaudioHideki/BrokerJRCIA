import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EmbedSessionClient } from './session-client.js';

const id = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002';
const token = 'synthetic-header.synthetic-payload.synthetic-signature';
const health = { integrationId: id, inboxId: 31, instanceId: id, integrationStatus: 'READY', instanceStatus: 'DISCONNECTED',
  transportStatus: 'UNVERIFIED', checkedAt: '2030-01-01T00:00:00Z', lastError: null, identityStatus: 'CONFIRMED', identityApproved: true,
  identityRevision: 1, observedNumberSuffix: null, callbackVerifiedAt: null, lastSuccessfulInboundAt: null, lastSuccessfulOutboundAt: null, allowedActions: ['status', 'pair'] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let clients: EmbedSessionClient[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z')); });
afterEach(() => { for (const client of clients) client.stop(); clients = []; vi.useRealTimers(); });
function setup() {
  const calls: { url: string; init: RequestInit }[] = []; let denied = false, canPair = true;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith('/authorizations')) return response({ requestId: id, expiresAt: new Date(Date.now() + 120000).toISOString() }, 201);
    if (url.endsWith('/exchange')) return response({ status: 'AUTHORIZED', token, expiresAt: new Date(Date.now() + 300000).toISOString(), accountId: 1,
      connections: [{ integrationId: id, inboxId: 31, name: 'Sintética', canPair }] });
    if (denied) return response({}, 403);
    if (url.endsWith('/status')) return response(health);
    return response({ instance: { id, organizationId: id, providerAccountId: id, provider: 'BAILEYS', name: 'Sintética', status: 'AWAITING_ACTION',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, operationId: other, pending: false, replayed: false, reconciliationRequired: false,
      action: { type: 'PAIRING_CODE', code: 'SYNTHETIC-ONLY', expiresAt: new Date(Date.now() + 30000).toISOString() } });
  });
  const client = new EmbedSessionClient(id, fetchImpl); clients.push(client);
  return { client, fetchImpl, calls, deny: () => { denied = true; }, readOnly: () => { canPair = false; } };
}
async function authorize(h: ReturnType<typeof setup>) { await h.client.begin(); await vi.advanceTimersByTimeAsync(1000); }

it('drops a late pairing challenge after a newer health response removes pairing permission', async () => {
  const h = setup(); await authorize(h);
  let complete!: (r: Response) => void;
  h.fetchImpl.mockImplementationOnce(async () => new Promise<Response>(resolve => { complete = resolve; }));
  const pairing = h.client.pair();
  h.fetchImpl.mockImplementationOnce(async () => response({ ...health, allowedActions: ['status'] }));
  await h.client.refresh();
  complete(response({ instance: { id, organizationId: id, providerAccountId: id, provider: 'BAILEYS', name: 'Synthetic', status: 'AWAITING_ACTION', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    operationId: other, pending: false, replayed: false, reconciliationRequired: false, action: { type: 'PAIRING_CODE', code: 'SYNTHETIC-LATE', expiresAt: new Date(Date.now() + 30000).toISOString() } }));
  await pairing; expect(h.client.snapshot().action).toBeNull();
});

it('starts only on user action, binds the proof and never exposes secrets in public state or URLs', async () => {
  const h = setup(); expect(h.fetchImpl).not.toHaveBeenCalled();
  const link = await h.client.begin(); expect(link).toBe(`/embed/authorize?requestId=${id}`);
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.client.snapshot().status).toBe('AUTHORIZED');
  const start = JSON.parse(h.calls[0]!.init.body as string), exchange = h.calls.find(c => c.url.endsWith('/exchange'))!;
  const { verifier } = JSON.parse(exchange.init.body as string);
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const received = Uint8Array.from(atob(start.challenge.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  expect(received).toEqual(expected);
  expect(h.calls.every(c => c.init.credentials === 'omit' && c.init.cache === 'no-store')).toBe(true);
  expect(JSON.stringify(h.client.snapshot())).not.toContain(token);
  expect(JSON.stringify(h.client.snapshot())).not.toContain(verifier);
  expect(h.calls.some(c => c.url.includes(verifier) || c.url.includes(token))).toBe(false);
  await h.client.pair(); expect(h.client.snapshot().action?.type).toBe('PAIRING_CODE');
  const call = h.calls.find(c => c.url.endsWith('/pair'))!;
  expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${token}`);
});
it('does not invoke browser fetch with the session client as receiver', async () => {
  const h = setup();
  const browserFetch: typeof fetch = async function (this: unknown, input, init) {
    if (this !== undefined) throw new TypeError('Illegal invocation');
    return h.fetchImpl(input, init);
  };
  const client = new EmbedSessionClient(id, browserFetch); clients.push(client);
  expect(await client.begin()).toBe(`/embed/authorize?requestId=${id}`);
});
it('expires the session and removes the challenge without user interaction', async () => {
  const h = setup(); await authorize(h); await h.client.pair();
  await vi.advanceTimersByTimeAsync(300000);
  expect(h.client.snapshot()).toMatchObject({ status: 'EXPIRED', action: null, connections: [] });
  const before = h.calls.length; await h.client.pair(); expect(h.calls).toHaveLength(before);
});
it('clears the challenge on conversation changes and rejects account or inbox outside the grant', async () => {
  const h = setup(); await authorize(h); await h.client.pair();
  h.client.context({ accountId: 1, inboxId: 31, conversationId: 2 });
  expect(h.client.snapshot().action).toBeNull();
  await h.client.pair(); h.client.context({ accountId: 2, inboxId: 31, conversationId: 2 });
  expect(h.client.snapshot().status).toBe('DENIED'); expect(h.client.snapshot().action).toBeNull();
  const otherInbox = setup(); await authorize(otherInbox);
  otherInbox.client.context({ accountId: 1, inboxId: 99, conversationId: 3 });
  expect(otherInbox.client.snapshot().status).toBe('DENIED');
});
it('drops QR and token after the next revoked-grant response and prevents read-only pairing', async () => {
  const h = setup(); await authorize(h); await h.client.pair(); h.deny(); await h.client.refresh();
  expect(h.client.snapshot()).toMatchObject({ status: 'DENIED', action: null });
  const viewer = setup(); viewer.readOnly(); await authorize(viewer); await viewer.client.pair();
  expect(viewer.calls.some(c => c.url.endsWith('/pair'))).toBe(false);
});
it('discards a delayed pair response after the context changed', async () => {
  const h = setup(); await authorize(h);
  let complete!: (response: Response) => void;
  h.fetchImpl.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
  const pending = h.client.pair();
  h.client.context({ accountId: 2, inboxId: 31, conversationId: 2 });
  complete(response({})); await pending;
  expect(h.client.snapshot()).toMatchObject({ status: 'DENIED', action: null });
});
it('refuses malformed context even before any valid context arrived', async () => {
  const h = setup(); await authorize(h); await h.client.pair(); h.client.context(null);
  expect(h.client.snapshot()).toMatchObject({ status: 'DENIED', action: null });
  const before = setup(); before.client.context(null); await authorize(before);
  expect(before.client.snapshot().status).toBe('DENIED');
});
