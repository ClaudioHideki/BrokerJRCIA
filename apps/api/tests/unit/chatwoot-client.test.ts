import { expect, it, vi } from 'vitest';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';

it('usa origem única e credencial no cabeçalho para criar caixa API', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 8, channel_type: 'Channel::Api', name: 'JRC', secret: 'webhook-secret', webhook_url: 'https://broker.test/events' })));
  const client = new ChatwootClient({ baseUrl: 'https://conversas.test', token: 'private-access', fetch });
  const inbox = await client.createInbox(1, 'JRC', 'https://broker.test/events');
  expect(inbox.id).toBe(8);
  expect(String(fetch.mock.calls[0]![0])).toBe('https://conversas.test/api/v1/accounts/1/inboxes');
  expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { api_access_token: 'private-access' } });
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ channel: { type: 'api', webhook_url: 'https://broker.test/events' } });
});
it('classifica timeout de criação como incerto e timeout de leitura como repetível', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('secret should not leak'));
  const client = new ChatwootClient({ baseUrl: 'https://conversas.test', token: 'private-access', fetch });
  await expect(client.createInbox(1, 'JRC', 'https://broker.test/events')).rejects.toMatchObject({ code: 'CHATWOOT_OUTCOME_UNKNOWN', uncertain: true, retrySafe: false });
  await expect(client.listInboxes(1)).rejects.toMatchObject({ code: 'CHATWOOT_UNAVAILABLE', uncertain: false, retrySafe: true });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('recusa redirecionamento e resposta excessiva sem vazar token', async () => {
  const client = new ChatwootClient({ baseUrl: 'https://conversas.test', token: 'private-access', fetch: vi.fn().mockResolvedValue(new Response('x'.repeat(2_100_000))) });
  await expect(client.listInboxes(1)).rejects.toMatchObject({ code: 'CHATWOOT_INVALID_RESPONSE' });
  expect(() => new ChatwootClient({ baseUrl: 'http://untrusted.test', token: 'x' })).toThrow('INVALID_CHATWOOT_ORIGIN');
});

it('reads existing agent display emails without treating them as authentication identities', async () => {
  const agents = [{ id: 12, name: 'Service operator', email: 'operator@internal' }];
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(agents))
    .mockResolvedValueOnce(Response.json({ payload: agents }));
  const client = new ChatwootClient({ baseUrl: 'https://conversas.test', token: 'synthetic-token', fetch });
  await expect(client.agents(1)).resolves.toEqual(agents);
  await expect(client.inboxAgents(1, 2)).resolves.toEqual(agents);
});

it.each(['agents', 'inboxAgents'] as const)('rejects invalid IDs and oversized display emails in %s without exposing the payload', async method => {
  for (const agent of [
    { id: 0, name: 'Operator', email: 'operator@internal' },
    { id: 12, name: 'Operator', email: 'x'.repeat(321) },
  ]) {
    const body = method === 'agents' ? [agent] : { payload: [agent] };
    const client = new ChatwootClient({ baseUrl: 'https://conversas.test', token: 'synthetic-token', fetch: vi.fn().mockResolvedValue(Response.json(body)) });
    await expect(method === 'agents' ? client.agents(1) : client.inboxAgents(1, 2)).rejects.toMatchObject({ code: 'CHATWOOT_INVALID_RESPONSE' });
  }
});

it('keeps platform user email validation strict for provisioning identity', async () => {
  const client = new ChatwootClient({ baseUrl: 'https://conversas.test', token: 'synthetic-token', fetch: vi.fn().mockResolvedValue(Response.json({ id: 12, email: 'operator@internal', access_token: 'synthetic-user-token' })) });
  await expect(client.platformUser(12)).rejects.toThrow();
});
