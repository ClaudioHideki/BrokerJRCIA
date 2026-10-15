import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { createConversationActionTransport } from './conversation-api.js';

const organizationId = '11111111-2222-4333-8444-555555555555';
const rootAutomationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const channelId = '12345678-1234-4234-8234-123456789abc';
const other = '99999999-2222-4333-8444-555555555555';
const scope = { organizationId, rootAutomationId, channelId };
const supported = { state: 'SUPPORTED', reason: null };
const catalog = { schemaVersion: 1, scope, profile: 'STANDALONE', capabilities: {
  tag: supported, attribute: supported, note: supported, resolve: supported, media: supported,
}, data: [], nextCursor: null };
const asset = { schemaVersion: 1, scope, id: other, revision: 1, status: 'READY', name: 'foto.png', kind: 'image',
  mimeType: 'image/png', byteSize: 3 };

describe('conversation action transport', () => {
  it('lists only the channels authorized for this root and checks the response scope', async () => {
    const request = vi.fn(async () => ({ schemaVersion: 1, scope: { organizationId, rootAutomationId },
      data: [{ id: channelId, name: 'Atendimento' }], nextCursor: null })) as ApiClient['request'];
    const transport = createConversationActionTransport({ request }, organizationId, rootAutomationId);
    const controller = new AbortController();
    expect(await transport.listChannels(controller.signal)).toEqual([{ id: channelId, name: 'Atendimento' }]);
    expect(request).toHaveBeenCalledWith(`/v1/automations/${rootAutomationId}/resource-channels?pageSize=200`, { signal: controller.signal });
    expect(vi.mocked(request).mock.calls.some(([path]) => path.startsWith('/v1/channels'))).toBe(false);
  });
  it('rejects a channel catalog for another company or root', async () => {
    for (const wrong of [{ organizationId: other, rootAutomationId }, { organizationId, rootAutomationId: other }]) {
      const request = vi.fn(async () => ({ schemaVersion: 1, scope: wrong, data: [], nextCursor: null })) as ApiClient['request'];
      await expect(createConversationActionTransport({ request }, organizationId, rootAutomationId).listChannels()).rejects.toMatchObject({ status: 409 });
    }
  });
  it('paginates resources without mixing capabilities or accepting duplicate IDs', async () => {
    const resource = { id: other, name: 'Urgente', kind: 'LABEL', revision: 'a'.repeat(64), definition: null };
    const request = vi.fn().mockResolvedValueOnce({ ...catalog, data: [resource], nextCursor: 'NEXT' })
      .mockResolvedValueOnce({ ...catalog, data: [], nextCursor: null }) as ApiClient['request'];
    const transport = createConversationActionTransport({ request }, organizationId, rootAutomationId);
    expect((await transport.actionCatalog(channelId)).data).toEqual([resource]);
    expect(request).toHaveBeenLastCalledWith(`/v1/automations/${rootAutomationId}/channels/${channelId}/action-catalog?pageSize=200&cursor=NEXT`, { signal: null });
    vi.mocked(request).mockReset().mockResolvedValueOnce({ ...catalog, data: [resource], nextCursor: 'NEXT' })
      .mockResolvedValueOnce({ ...catalog, data: [resource] });
    await expect(transport.actionCatalog(channelId)).rejects.toMatchObject({ status: 502 });
    vi.mocked(request).mockReset().mockResolvedValueOnce({ ...catalog, nextCursor: 'NEXT' })
      .mockResolvedValueOnce({ ...catalog, profile: 'CENTRAL' });
    await expect(transport.actionCatalog(channelId)).rejects.toMatchObject({ status: 409 });
  });
  it('refuses a response for another channel and inconsistent private media scope', async () => {
    const request = vi.fn(async () => ({ ...catalog, scope: { ...scope, channelId: other } })) as ApiClient['request'];
    const transport = createConversationActionTransport({ request }, organizationId, rootAutomationId);
    await expect(transport.actionCatalog(channelId)).rejects.toMatchObject({ status: 409 });
    vi.mocked(request).mockResolvedValue({ schemaVersion: 1, scope, data: [{ ...asset, scope: { ...scope, channelId: other } }] });
    await expect(transport.mediaCatalog(channelId)).rejects.toMatchObject({ status: 409 });
  });
  it('stops pagination after cancellation, even if the client returns a page late', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => { controller.abort(); return { ...catalog, nextCursor: 'NEXT' }; }) as ApiClient['request'];
    await expect(createConversationActionTransport({ request }, organizationId, rootAutomationId)
      .actionCatalog(channelId, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('uploads bounded binary data with only the scoped route and explicit media headers', async () => {
    const request = vi.fn(async () => asset) as ApiClient['request'];
    const transport = createConversationActionTransport({ request }, organizationId, rootAutomationId);
    const file = new File(['abc'], 'foto.png', { type: 'image/png' }), controller = new AbortController();
    expect(await transport.uploadMedia(channelId, file, 'image', controller.signal)).toEqual(asset);
    const [path, options] = vi.mocked(request).mock.calls[0]!;
    expect(path).toBe(`/v1/automations/${rootAutomationId}/channels/${channelId}/media`);
    expect(options).toMatchObject({ method: 'POST', body: file, signal: controller.signal, headers: {
      'Content-Type': 'application/octet-stream', 'x-jrc-media-mime': 'image/png', 'x-jrc-media-kind': 'image', 'x-jrc-media-name': 'foto.png',
    } });
    expect(new Headers(options?.headers).get('idempotency-key')).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('does not send an empty or oversized file and rejects a foreign upload receipt', async () => {
    const request = vi.fn(async () => ({ ...asset, scope: { ...scope, organizationId: other } })) as ApiClient['request'];
    const transport = createConversationActionTransport({ request }, organizationId, rootAutomationId);
    for (const file of [new File([], 'empty.png', { type: 'image/png' }),
      new File([new Uint8Array(16777217)], 'large.png', { type: 'image/png' })]) {
      await expect(transport.uploadMedia(channelId, file, 'image')).rejects.toMatchObject({ status: 413 });
    }
    expect(request).not.toHaveBeenCalled();
    await expect(transport.uploadMedia(channelId, new File(['abc'], 'foto.png', { type: 'image/png' }), 'image')).rejects.toMatchObject({ status: 409 });
  });
  it('saves a typed local resource and revokes only a media ID in its own scope', async () => {
    const request = vi.fn(async () => undefined) as ApiClient['request'];
    const transport = createConversationActionTransport({ request }, organizationId, rootAutomationId);
    const input = { name: 'Ativo', key: 'ativo', kind: 'ATTRIBUTE' as const,
      definition: { valueType: 'boolean' as const, maxLength: 4096, allowedValues: [] }, status: 'ACTIVE' as const };
    await transport.saveResource(channelId, input);
    expect(request).toHaveBeenCalledWith(`/v1/automations/${rootAutomationId}/channels/${channelId}/action-resources`, {
      method: 'POST', signal: null, body: JSON.stringify(input),
    });
    await transport.revokeMedia(channelId, other, 2);
    expect(vi.mocked(request).mock.calls.at(-1)).toEqual([`/v1/automations/${rootAutomationId}/channels/${channelId}/media/${other}/revoke`, {
      method: 'POST', body: '{"revision":2}', signal: null, headers: { 'Idempotency-Key': expect.stringMatching(/^[a-f0-9-]{36}$/) },
    }]);
  });
});
