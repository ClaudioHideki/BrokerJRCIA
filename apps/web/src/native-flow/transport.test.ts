// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createNativeEditorTransport, type NativeEditorOptions } from './transport.js';
const root = '11111111-2222-4333-8444-555555555555', other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const handle = '12345678-1234-4234-8234-123456789abc', channel = '76543210-1234-4234-8234-123456789abc';
const prefix = `/api/v1/accounts/3/jrc_flow_delegation/sessions/${handle}/flows`;
function transport(request = vi.fn<NativeEditorOptions['request']>(async () => ({})), pin = true) {
  return { client: createNativeEditorTransport({ accountId: 3, handleId: handle, integrationIds: [channel],
    ...(pin ? { rootAutomationId: root } : {}), request }), request };
}
it('maps paginated action catalogs to the exact Account/session/root and leaves page size to the BFF', async () => {
  const { client, request } = transport();
  await client.request(`/v1/automations/${root}/resource-channels?pageSize=200&cursor=next_1`);
  await client.request(`/v1/automations/${root}/channels/${channel}/action-catalog?pageSize=200`);
  expect(request.mock.calls.map(args => args.slice(0, 3))).toEqual([
    ['get', `${prefix}/${root}/resource-channels?cursor=next_1`, undefined],
    ['get', `${prefix}/${root}/channels/${channel}/action-catalog`, undefined],
  ]);
});
it('cannot retarget a pinned editor or its handoff catalogs to another root', async () => {
  const { client, request } = transport();
  await expect(client.request(`/v1/automations/${other}`)).rejects.toThrow('FLOW_ROOT_MISMATCH');
  await client.request('/v1/integrations/chatwoot');
  expect(request).toHaveBeenCalledWith('get', `${prefix}/${root}/handoff-connections`, undefined, undefined, undefined);
  const workspace = transport(vi.fn<NativeEditorOptions['request']>(async () => ({ id: other, scopeRevision: 2 })), false);
  await workspace.client.request(`/v1/automations/${other}`);
  await expect(workspace.client.request('/v1/integrations/chatwoot')).rejects.toThrow('FLOW_UNSUPPORTED_OPERATION');
});
it('uses only the selected integrations when creating a draft and pins the scope revision when saving', async () => {
  const request = vi.fn<NativeEditorOptions['request']>(async (_method, path) => path.endsWith('/scope') ? { revision: 7 } : {});
  const { client } = transport(request);
  await client.request('/v1/automations', { method: 'POST', body: JSON.stringify({ name: 'Teste', graph: {} }) });
  await client.request(`/v1/automations/${root}`, { method: 'PUT', body: JSON.stringify({ name: 'Novo', graph: {}, expectedScopeRevision: 999 }) });
  expect(request.mock.calls[0]?.slice(0, 3)).toMatchObject(['post', prefix, { integrationIds: [channel], name: 'Teste' }]);
  expect(request.mock.calls[2]?.slice(0, 3)).toMatchObject(['put', `${prefix}/${root}`, { expectedScopeRevision: 7 }]);
});
it('keeps private media bytes out of JSON and carries only the required metadata', async () => {
  const { client, request } = transport(), bytes = new Uint8Array([0, 2, 255]);
  await client.request(`/v1/automations/${root}/channels/${channel}/media`, { method: 'POST', body: bytes,
    headers: { 'content-type': 'application/octet-stream', 'idempotency-key': other,
      'x-jrc-media-mime': 'image/png', 'x-jrc-media-kind': 'image', 'x-jrc-media-name': 'teste.png' } });
  expect(request.mock.calls[0]).toEqual(['post', `${prefix}/${root}/channels/${channel}/media`, bytes, undefined, other,
    { 'x-jrc-media-mime': 'image/png', 'x-jrc-media-kind': 'image', 'x-jrc-media-name': 'teste.png' }]);
  await expect(client.request(`/v1/automations/${root}/channels/${channel}/media`, { method: 'POST', body: JSON.stringify({ data: 'base64' }) })).rejects.toThrow('FLOW_INVALID_REQUEST');
});
it('lists and revokes only scoped private assets and writes typed resources', async () => {
  const { client, request } = transport();
  await client.request(`/v1/automations/${root}/channels/${channel}/media`);
  await client.request(`/v1/automations/${root}/channels/${channel}/media/${other}/revoke`, { method: 'POST', body: '{"revision":2}' });
  await client.request(`/v1/automations/${root}/channels/${channel}/action-resources`, { method: 'POST', body: JSON.stringify({ kind: 'ATTRIBUTE', definition: { valueType: 'boolean' } }) });
  expect(request.mock.calls.map(call => call[1])).toEqual([
    `${prefix}/${root}/channels/${channel}/media`, `${prefix}/${root}/channels/${channel}/media/${other}/revoke`,
    `${prefix}/${root}/channels/${channel}/action-resources`,
  ]);
  expect(request.mock.calls[1]?.[2]).toEqual({ revision: 2 });
});
it('rejects foreign origins, path normalization, credential headers, duplicate queries and unsupported global routes', async () => {
  const { client, request } = transport();
  for (const path of ['https://other.test/v1/automations', '/v1/automations/../channels', '/v1/channels',
    `/v1/automations/${root}/versions?cursor=a&cursor=b`, `/v1/automations/${root}/media?x=y`,
    `/v1/automations/${root}/channels/${channel}/action-catalog/${other}/revoke`]) {
    await expect(client.request(path)).rejects.toThrow();
  }
  await expect(client.request('/v1/automations', { headers: { authorization: 'forbidden-fixture' } })).rejects.toThrow('FLOW_INVALID_REQUEST');
  expect(request).not.toHaveBeenCalled();
});
it('drops a late response when the editor was closed', async () => {
  let finish!: (value: unknown) => void;
  const request = vi.fn<NativeEditorOptions['request']>(() => new Promise(resolve => { finish = resolve; }));
  const { client } = transport(request), controller = new AbortController();
  const pending = client.request(`/v1/automations/${root}`, { signal: controller.signal });
  controller.abort(); finish({ id: root, scopeRevision: 1 });
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
