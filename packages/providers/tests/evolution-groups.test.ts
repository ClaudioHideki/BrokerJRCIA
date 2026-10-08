import { describe, expect, it } from 'vitest';
import { EvolutionGroupsClient } from '../src/evolution/groups.js';
import type { ProviderContext } from '../src/contracts/types.js';

// Synthetic group IDs, not customer payloads. Upstream fa09d378:
// group.router.ts fetchAllGroups + whatsapp.baileys.service.ts:4448.
const groupJid = '120000000000001@g.us';
const legacyGroupJid = '120000000000002-1500000000@g.us';
const context: ProviderContext = {
  organizationId: 'synthetic-organization', requestId: 'synthetic-group-request',
  deadline: new Date('2030-01-01T00:00:00.000Z'), signal: new AbortController().signal,
};
const group = {
  id: groupJid, subject: 'Synthetic group', size: 3,
  restrict: true, announce: false, isCommunity: false, isCommunityAnnounce: false,
};

function setup(body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const client = new EvolutionGroupsClient({
    baseUrl: 'http://engine.test', apiKey: 'synthetic-api-key',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return body instanceof Response ? body : new Response(JSON.stringify(body));
    },
  });
  return { client, calls };
}

describe('Evolution QR group catalog (G1)', () => {
  it('uses one verified GET with getParticipants=false and no remote pagination', async () => {
    const { client, calls } = setup([{ ...group, linkedParent: legacyGroupJid }]);
    expect(await client.list(context, 'key /&')).toEqual([{
      groupJid, subject: 'Synthetic group', participantCount: 3,
      restrict: true, announce: false, isCommunity: false,
      isCommunityAnnounce: false, linkedParent: legacyGroupJid,
    }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://engine.test/group/fetchAllGroups/key%20%2F%26?getParticipants=false');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.redirect).toBe('error');
    expect(new Headers(calls[0]?.init?.headers).get('apikey')).toBe('synthetic-api-key');
    expect(new Headers(calls[0]?.init?.headers).get('x-request-id')).toBe('synthetic-group-request');
  });

  it('discards participants, owners, descriptions, picture URLs and arbitrary credentials', async () => {
    const { client } = setup([{
      ...group, owner: 'synthetic-owner', subjectOwner: 'synthetic-owner',
      participants: [{ id: 'synthetic-participant', admin: 'admin' }],
      desc: 'synthetic-private-description', pictureUrl: 'http://private.test/picture',
      token: 'synthetic-private-token', voiceSupported: true,
    }]);
    expect(await client.list(context, 'key')).toEqual([{
      groupJid, subject: 'Synthetic group', participantCount: 3,
      restrict: true, announce: false, isCommunity: false,
      isCommunityAnnounce: false, linkedParent: null,
    }]);
  });

  it('preserves absent metadata as unknown and accepts the legacy group JID shape', async () => {
    const { client } = setup([{ id: legacyGroupJid, subject: 'Synthetic legacy group', size: 0 }]);
    expect(await client.list(context, 'key')).toEqual([{
      groupJid: legacyGroupJid, subject: 'Synthetic legacy group', participantCount: 0,
      restrict: null, announce: null, isCommunity: null, isCommunityAnnounce: null, linkedParent: null,
    }]);
  });

  it('accepts a successful empty array without fabricating membership or groups', async () => {
    const { client, calls } = setup([]);
    expect(await client.list(context, 'key')).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it.each([
    { groups: [group], nextPage: 2 }, null, { error: 'synthetic-private-error' },
    [group, { ...group, subject: 'Ambiguous duplicate' }],
    [group, { ...group, id: 'synthetic@s.whatsapp.net' }],
    [group, { ...group, id: 'synthetic@lid' }],
    [group, { ...group, id: 'status@broadcast' }],
    [group, { ...group, id: legacyGroupJid, subject: ' ' }],
    [group, { ...group, id: legacyGroupJid, subject: 'x'.repeat(257) }],
    [group, { ...group, id: legacyGroupJid, size: -1 }], [group, { ...group, id: legacyGroupJid, size: 1.5 }],
    [group, { ...group, id: legacyGroupJid, size: '3' }], [group, { ...group, id: legacyGroupJid, size: 100_001 }],
    [group, { ...group, id: legacyGroupJid, announce: 'false' }],
    [group, { ...group, id: legacyGroupJid, isCommunity: 1 }],
    [group, { ...group, id: legacyGroupJid, linkedParent: 'synthetic@lid' }],
  ])('rejects an invalid or ambiguous snapshot atomically (%#)', async (body) => {
    const { client } = setup(body);
    await expect(client.list(context, 'key')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('rejects more than 2000 groups instead of returning a truncated local snapshot', async () => {
    const body = Array.from({ length: 2001 }, (_, index) => ({
      ...group, id: `${120000000000001n + BigInt(index)}@g.us`,
    }));
    const { client } = setup(body);
    await expect(client.list(context, 'key')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('rejects oversized Content-Length before consuming the body', async () => {
    let consumed = false;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { consumed = true; controller.enqueue(new TextEncoder().encode('[]')); controller.close(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const { client } = setup(new Response(body, { headers: { 'content-length': '2097153' } }));
    await expect(client.list(context, 'key')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    expect(consumed).toBe(false);
    expect(cancelled).toBe(true);
  });

  it.each([{}, { 'content-length': '2' }, { 'transfer-encoding': 'chunked' }])(
    'enforces 2 MiB on streamed bytes regardless of length/transfer headers (%#)', async (headers) => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(1_048_577)); },
        cancel() { cancelled = true; },
      });
      const { client } = setup(new Response(body, { headers }));
      await expect(client.list(context, 'key')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
      expect(cancelled).toBe(true);
    },
  );

  it('rejects invalid UTF-8 rather than accepting replacement characters in group metadata', async () => {
    const prefix = new TextEncoder().encode(`[{"id":"${groupJid}","subject":"`);
    const suffix = new TextEncoder().encode('","size":1}]');
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
    bytes.set(prefix); bytes[prefix.length] = 0xff; bytes.set(suffix, prefix.length + 1);
    const { client } = setup(new Response(bytes));
    await expect(client.list(context, 'key')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('accepts valid UTF-8 characters split across stream chunks', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify([{ ...group, subject: 'Synthetic ação' }]));
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
        else controller.close();
      },
    });
    const { client } = setup(new Response(body));
    expect((await client.list(context, 'key'))[0]?.subject).toBe('Synthetic ação');
  });

  it('rejects malformed JSON, does not return an empty catalog and never retries', async () => {
    const { client, calls } = setup(new Response('[{"id":'));
    await expect(client.list(context, 'key')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    expect(calls).toHaveLength(1);
  });

  it.each([401, 404, 429, 500])('redacts HTTP failure %i and does not retry', async (status) => {
    const { client, calls } = setup(new Response('synthetic-private-error', { status }));
    await expect(client.list(context, 'key')).rejects.toMatchObject({ message: 'PROVIDER_REQUEST_FAILED', code: 'PROVIDER_REQUEST_FAILED' });
    expect(calls).toHaveLength(1);
  });

  it('cancels a stalled body at the caller deadline, including response consumption', async () => {
    let cancelled = false;
    const { client, calls } = setup(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
    await expect(client.list({ ...context, deadline: new Date(Date.now() + 40) }, 'key'))
      .rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(calls).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  it('applies a real 15 second default to a stalled body even with a later deadline', async () => {
    let cancelled = false;
    const { client } = setup(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
    const startedAt = Date.now();
    await expect(client.list(context, 'key')).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(14_900);
    expect(cancelled).toBe(true);
  }, 20_000);

  it('preserves caller cancellation during a stalled body', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const { client, calls } = setup(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
    const result = client.list({ ...context, signal: controller.signal }, 'key');
    const assertion = expect(result).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });
    controller.abort();
    await assertion;
    expect(calls).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  it('does not request upstream after caller cancellation or an expired deadline', async () => {
    const { client, calls } = setup([]);
    await expect(client.list({ ...context, signal: AbortSignal.abort() }, 'key'))
      .rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });
    await expect(client.list({ ...context, deadline: new Date(0) }, 'key'))
      .rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(calls).toHaveLength(0);
  });

  it.each(['', '.', '..', 'x'.repeat(201)])('does not request with an invalid instance key (%#)', async (key) => {
    const { client, calls } = setup([]);
    await expect(client.list(context, key)).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONTEXT' });
    expect(calls).toHaveLength(0);
  });
});
