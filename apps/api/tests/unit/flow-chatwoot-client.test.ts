import { describe, expect, it, vi } from 'vitest';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';

describe('Chatwoot Agent Bot transport', () => {
  it('starts mirrored WhatsApp conversations in pending only when a flow owns the inbox', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ id: 19 }));
    const client = new ChatwootClient({ baseUrl: 'https://support.example.test', token: 'synthetic-admin', fetch });
    await client.createConversation(2, { inboxId: 7, contactId: 3, sourceId: 'source', status: 'pending' });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).status).toBe('pending');
  });
  it('reads scoped bots, creates one with signing capability and assigns it to an inbox', async () => {
    const bot = { id: 8, name: 'JRC Flow', outgoing_url: 'https://broker.example.test/v1/flows/chatwoot/abc/events',
      secret: 'synthetic-webhook-secret', access_token: { token: 'synthetic-bot-token' } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json([bot]))
      .mockResolvedValueOnce(Response.json(bot)).mockResolvedValueOnce(Response.json({ agent_bot: null }))
      .mockResolvedValueOnce(Response.json({}));
    const client = new ChatwootClient({ baseUrl: 'https://support.example.test', token: 'synthetic-admin-token', fetch });
    expect((await client.listFlowBots(2))[0]?.id).toBe(8);
    expect(await client.createFlowBot(2, 'JRC Flow', bot.outgoing_url)).toMatchObject({ id: 8, secret: bot.secret, token: 'synthetic-bot-token' });
    expect(await client.inboxFlowBot(2, 7)).toBeNull();
    await client.setInboxFlowBot(2, 7, 8);
    expect(fetch.mock.calls[3]?.[0]).toBe('https://support.example.test/api/v1/accounts/2/inboxes/7/set_agent_bot');
    expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body))).toEqual({ agent_bot: 8 });
  });
  it('requires pending state and keeps flow replies distinct from transport mirror messages', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ id: 9, account_id: 2, inbox_id: 7,
      status: 'pending', meta: { sender: { id: 3, name: 'Ana' } } })).mockResolvedValueOnce(Response.json({ id: 11 }));
    const client = new ChatwootClient({ baseUrl: 'https://support.example.test', token: 'bot-token', fetch });
    expect((await client.flowConversation(2, 9)).status).toBe('pending');
    await client.sendFlowMessage(2, 9, 'Resposta sintética', 'flow-delivery-1');
    const payload = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(payload).toMatchObject({ private: false, message_type: 'outgoing', content_attributes: { jrc_flow_delivery_id: 'flow-delivery-1' } });
    expect(payload.content_attributes).not.toHaveProperty('jrc_broker_message_id');
  });
});
