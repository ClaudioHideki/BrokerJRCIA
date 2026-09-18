import { describe, expect, it } from 'vitest';
import { parseFlowChatwootEvent } from '../../src/modules/flows/chatwoot-events.js';

const binding = { accountId: 2, inboxId: 7, botId: 8 };
const message = { event: 'message_created', id: 10, account: { id: 2 }, inbox: { id: 7 },
  conversation: { id: 9, inbox_id: 7 }, private: false, message_type: 'incoming', content: 'Olá',
  sender: { id: 3, type: 'contact', name: 'Cliente sintético' } };

describe('Flow Agent Bot events', () => {
  it.each(['Channel::Api', 'Channel::Whatsapp', 'Channel::Instagram', 'Channel::Email'])('accepts an incoming text in %s', channel_type => {
    expect(parseFlowChatwootEvent({ ...message, inbox: { id: 7, channel_type } }, binding))
      .toMatchObject({ kind: 'TURN', key: 'message:10', conversationId: 9, messageId: 10, text: 'Olá' });
  });
  it('rejects a different account or inbox before any turn', () => {
    expect(() => parseFlowChatwootEvent({ ...message, account: { id: 99 } }, binding)).toThrow('FLOW_CHATWOOT_BINDING_MISMATCH');
    expect(() => parseFlowChatwootEvent({ ...message, conversation: { id: 9, inbox_id: 99 } }, binding)).toThrow('FLOW_CHATWOOT_BINDING_MISMATCH');
  });
  it('ignores private notes, updates and its own bot replies', () => {
    expect(parseFlowChatwootEvent({ ...message, private: true }, binding)).toBeNull();
    expect(parseFlowChatwootEvent({ ...message, event: 'message_updated' }, binding)).toBeNull();
    expect(parseFlowChatwootEvent({ ...message, message_type: 'outgoing', sender: { id: 8, type: 'agent_bot' } }, binding)).toBeNull();
  });
  it('pauses on a human or competing bot public reply', () => {
    expect(parseFlowChatwootEvent({ ...message, message_type: 1, sender: { id: 3, type: 'user' } }, binding)?.kind).toBe('HUMAN');
    expect(parseFlowChatwootEvent({ ...message, message_type: 1, sender: { id: 9, type: 'agent_bot' } }, binding)?.kind).toBe('HUMAN');
  });
  it('ignores attachments without a text rather than pretending to understand them', () => {
    expect(parseFlowChatwootEvent({ ...message, content: null, attachments: [{ id: 42 }] }, binding)).toBeNull();
  });
});
