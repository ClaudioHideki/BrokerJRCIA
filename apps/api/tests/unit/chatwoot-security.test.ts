import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { createIntegrationSecrets, verifyChatwootSignature } from '../../src/modules/integrations/secrets.js';
import { parseChatwootReply } from '../../src/modules/integrations/chatwoot-events.js';

it('cifra credenciais com associação à empresa e detecta alteração', () => {
  const vault = createIntegrationSecrets(Buffer.alloc(32, 7).toString('base64'));
  const encrypted = vault.encrypt('org-a', 'private-token');
  expect(encrypted).not.toContain('private-token');
  expect(vault.decrypt('org-a', encrypted)).toBe('private-token');
  expect(() => vault.decrypt('org-b', encrypted)).toThrow('INTEGRATION_SECRET_UNAVAILABLE');
  expect(() => vault.decrypt('org-a', encrypted.slice(0, -8))).toThrow('INTEGRATION_SECRET_UNAVAILABLE');
});
it('valida corpo original, assinatura e idade do webhook', () => {
  const body = Buffer.from('{"event":"message_created"}');
  const timestamp = '1789470000';
  const signature = 'sha256=' + createHmac('sha256', 'secret').update(timestamp + '.').update(body).digest('hex');
  expect(verifyChatwootSignature('secret', body, timestamp, signature, 1789470001000)).toBe(true);
  expect(verifyChatwootSignature('secret', Buffer.from('{}'), timestamp, signature, 1789470001000)).toBe(false);
  expect(verifyChatwootSignature('secret', body, timestamp, signature, 1789470400000)).toBe(false);
});
const reply = { event: 'message_created', id: 10, account: { id: 1 }, inbox: { id: 8 }, conversation: { id: 20, inbox_id: 8 }, message_type: 'outgoing', private: false, content: 'Resposta do atendente', content_attributes: {} };
it('aceita somente respostas públicas da conta/caixa vinculadas', () => {
  expect(parseChatwootReply(reply, { accountId: 1, inboxId: 8 })).toMatchObject({ messageId: 10, conversationId: 20, content: { type: 'TEXT', text: reply.content } });
  expect(() => parseChatwootReply(reply, { accountId: 2, inboxId: 8 })).toThrow('CHATWOOT_BINDING_MISMATCH');
  expect(parseChatwootReply({ ...reply, private: true }, { accountId: 1, inboxId: 8 })).toBeNull();
  expect(parseChatwootReply({ ...reply, message_type: 'incoming' }, { accountId: 1, inboxId: 8 })).toBeNull();
  expect(parseChatwootReply({ ...reply, content_attributes: { jrc_broker_message_id: 'already-mirrored' } }, { accountId: 1, inboxId: 8 })).toBeNull();
});
