import { expect, it } from 'vitest';
import { MessageViewSchema } from '@jrc/contracts';
import { messageView } from '../../src/modules/messaging/service.js';
import type { Message } from '../../src/modules/messaging/types.js';

it('preserva origem externa observada no contrato público sem atribuir agente', () => {
  const raw = { id: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222', channelId: '33333333-3333-4333-8333-333333333333', conversationId: '44444444-4444-4444-8444-444444444444', direction: 'OUTGOING', source: 'EXTERNAL_OBSERVED', upstreamMessageId: 'synthetic-provider-id', content: { type: 'TEXT', text: 'Saída sintética' }, state: 'SENT', canonicalErrorCode: null, createdAt: new Date(), updatedAt: new Date() } as unknown as Message;
  expect(MessageViewSchema.parse(messageView(raw))).toEqual({ id: raw.id, direction: 'OUTGOING', source: 'EXTERNAL_OBSERVED', state: 'SENT', text: 'Saída sintética' });
});
