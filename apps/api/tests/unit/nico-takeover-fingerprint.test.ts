import { expect, it } from 'vitest';
import { nicoSendFingerprint } from '../../src/modules/integrations/nico-takeovers.js';

it('matches the Ruby contract across accents, emoji, quotes and embedded newlines', () => {
  const scope = { organizationId: '11111111-2222-4333-8444-555555555555', accountId: 1, inboxId: 2, remoteConversationId: 3 };
  const content = 'Olá <JRC> 😀\n"teste"';
  expect(nicoSendFingerprint(scope, '4', content)).toBe('d7cc58a450c97d442385e8621b3dc880248af6bc6bd58a04ad4f8d2ce03fb4e7');
  expect(nicoSendFingerprint(scope, '4', `${content}\n`)).not.toBe(nicoSendFingerprint(scope, '4', content));
  expect(nicoSendFingerprint({ ...scope, inboxId: 3 }, '4', content)).not.toBe(nicoSendFingerprint(scope, '4', content));
});
