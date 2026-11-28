import { expect, it } from 'vitest';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';

const root = '/api/v1/accounts/7/conversations/51';
const tuple = [7, 9, 51, 'aaaa', 'provider-a', 'organization-a'] as const;
const expected = { contact_id: '31', source_id: 'test-source', phone: '15550000000' };
const contact = { id: 31, phone_number: '+1 555 000 0000' };
const binding = { id: 12, contact_id: 31, inbox_id: 9, source_id: expected.source_id };
const detail = { id: 51, account_id: 7, inbox_id: 9, meta: { sender: contact }, contact_inbox: binding, messages: [] };
const page = { meta: { contact }, payload: [] };

function sequence(responses: Response[]) {
  const requests: string[] = [];
  const client = new ChatwootClient({ baseUrl: 'https://central.example.test', token: 'synthetic',
    fetch: async (url, options) => {
      const { pathname, search } = new URL(String(url));
      requests.push(`${options?.method} ${pathname}${search}`);
      const response = responses.shift();
      if (!response) throw Error('Unexpected request');
      return response;
    } });
  return { client, requests };
}
const json = (value: unknown) => Response.json(value);

it('reports incomplete history when the list hides the persisted message visible in the detail', async () => {
  const stored = [{ id: 80, source_id: 'provider-a' }];
  const { client, requests } = sequence([json(page), json({ ...detail, messages: stored })]);
  await expect(client.reviewMirrorHistory(...tuple, expected)).rejects.toThrow('CHATWOOT_REVIEW_HISTORY_INCOMPLETE');
  expect(requests).toEqual([`GET ${root}/messages`, `GET ${root}`]);
  expect(stored).toEqual([{ id: 80, source_id: 'provider-a' }]);
});

it('keeps ordinary history review closed on the first unanchored empty page', async () => {
  const { client, requests } = sequence([json(page)]);
  await expect(client.reviewMirrorHistory(...tuple)).rejects.toThrow('CHATWOOT_REVIEW_HISTORY_INCOMPLETE');
  expect(requests).toEqual([`GET ${root}/messages`]);
});

it('classifies a scoped double read as an observation and never approves it', async () => {
  const { client, requests } = sequence([json(page), json(detail), json(page)]);
  await expect(client.reviewMirrorHistory(...tuple, expected)).rejects.toThrow('CHATWOOT_REVIEW_EMPTY_SNAPSHOT_ONLY');
  expect(requests).toEqual([`GET ${root}/messages`, `GET ${root}`, `GET ${root}/messages`]);
});

it.each([
  ['missing projection', () => json({ ...detail, messages: undefined })],
  ['private or activity message', () => json({ ...detail, messages: [{ id: 40, private: true }] })],
  ['foreign account', () => json({ ...detail, account_id: 8 })],
  ['foreign inbox', () => json({ ...detail, inbox_id: 8 })],
  ['foreign conversation', () => json({ ...detail, id: 52 })],
  ['changed source', () => json({ ...detail, contact_inbox: { ...binding, source_id: 'other' } })],
  ['missing contact binding', () => json({ ...detail, contact_inbox: null })],
  ['changed sender', () => json({ ...detail, meta: { sender: { ...contact, id: 32 } } })],
  ['changed phone', () => json({ ...detail, meta: { sender: { ...contact, phone_number: null } } })],
  ['partial status', () => Response.json(detail, {status: 206})],
  ['ranged response', () => Response.json(detail, {headers: {'content-range': 'bytes 0-99/200'}})],
  ['truncated JSON', () => new Response('{"messages":[')],
] as const)('rejects %s as evidence of an empty history', async (_, response) => {
  const { client, requests } = sequence([json(page), response()]);
  await expect(client.reviewMirrorHistory(...tuple, expected)).rejects.toThrow(/^(?!CHATWOOT_REVIEW_EMPTY_SNAPSHOT_ONLY$)CHATWOOT_/);
  expect(requests).toEqual([`GET ${root}/messages`, `GET ${root}`]);
});

it.each([
  ['changed head', () => json({ ...page, payload: [{ id: 80, source_id: 'provider-a' }] })],
  ['foreign list', () => json({ meta: { contact: { ...contact, id: 32 } }, payload: [] })],
  ['missing metadata', () => json({ payload: [] })],
  ['partial list', () => Response.json(page, { status: 206 })],
] as const)('rejects %s on the unfiltered reread', async (_, response) => {
  const { client } = sequence([json(page), json(detail), response()]);
  await expect(client.reviewMirrorHistory(...tuple, expected)).rejects.toThrow(/^(?!CHATWOOT_REVIEW_EMPTY_SNAPSHOT_ONLY$)CHATWOOT_/);
});

it('leaves the candidate blocked when a provider-only writer commits just after the last GET', async () => {
  const rows: Array<{source_id: string}> = [];
  const methods: string[] = [];
  const client = new ChatwootClient({ baseUrl: 'https://central.example.test', token: 'synthetic', fetch: async (url, options) => {
    methods.push(String(options?.method));
    if (new URL(String(url)).pathname === root) return json(detail);
    const response = json({ ...page, payload: rows.slice() });
    if (methods.length === 3) rows.push({ source_id: tuple[4] });
    return response;
  } });
  await expect(client.reviewMirrorHistory(...tuple, expected)).rejects.toThrow('CHATWOOT_REVIEW_EMPTY_SNAPSHOT_ONLY');
  expect(rows).toEqual([{source_id: tuple[4]}]);
  expect(methods).toEqual(['GET', 'GET', 'GET']);
});
