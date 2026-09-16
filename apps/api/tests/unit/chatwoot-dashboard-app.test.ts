import { expect, it, vi } from 'vitest';
import { buildDashboardAppPayload, buildDashboardAppUrl } from '../../src/modules/integrations/embed/apps.js';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';
const id = '884c4ce2-741f-47a1-b9a2-ccfbcbb60231';
const url = `https://broker.example.test/embed/chatwoot/${id}`;
it('generates only the Broker origin URL and the confirmed Application API payload', () => {
  expect(buildDashboardAppUrl('https://broker.example.test', id)).toBe(url);
  for (const origin of ['https://broker.example.test/?token=x', 'https://user:pass@broker.example.test', 'https://broker.example.test/other', 'http://remote.example.test'])
    expect(() => buildDashboardAppUrl(origin, id)).toThrow();
  expect(buildDashboardAppPayload('Conexões JRC', url)).toEqual({ dashboard_app: { title: 'Conexões JRC', content: [{ type: 'frame', url }] } });
});
it('lists and creates via the approved Application API, retaining no credentials in the body', async () => {
  const remote = { id: 7, title: 'Conexões JRC', content: [{ type: 'frame', url }] };
  const fetch = vi.fn().mockResolvedValueOnce(Response.json([remote])).mockResolvedValueOnce(Response.json(remote));
  const client = new ChatwootClient({ baseUrl: 'https://chatwoot.example.test', token: 'synthetic-private', fetch });
  expect(await client.listDashboardApps(9)).toEqual([remote]);
  expect(await client.createDashboardApp(9, buildDashboardAppPayload(remote.title, url))).toEqual(remote);
  for (const call of fetch.mock.calls) {
    expect(call[0]).toBe('https://chatwoot.example.test/api/v1/accounts/9/dashboard_apps');
    expect(call[1]).toMatchObject({ redirect: 'error', headers: { api_access_token: 'synthetic-private' } });
    expect(String(call[1].body)).not.toContain('synthetic-private');
  }
});
it('keeps absent capability separate from uncertain POST outcomes', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockRejectedValueOnce(new Error('untrusted secret'));
  const client = new ChatwootClient({ baseUrl: 'https://chatwoot.example.test', token: 'synthetic', fetch });
  await expect(client.listDashboardApps(1)).rejects.toMatchObject({ httpStatus: 404, uncertain: false });
  await expect(client.createDashboardApp(1, buildDashboardAppPayload('JRC', url))).rejects.toMatchObject({ uncertain: true });
});
