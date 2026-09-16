import { expect, it } from 'vitest';
import { isAllowedContextEvent, parseAppContext, isContextGranted } from './context.js';
const origin = 'https://client.example.com';
it('rejects other origins and windows, including opaque origins', () => {
  expect(isAllowedContextEvent({ origin: 'https://evil.example', sourceIsParent: true }, origin)).toBe(false);
  expect(isAllowedContextEvent({ origin, sourceIsParent: false }, origin)).toBe(false);
  expect(isAllowedContextEvent({ origin: 'null', sourceIsParent: true }, origin)).toBe(false);
  expect(isAllowedContextEvent({ origin, sourceIsParent: true }, origin)).toBe(true);
});
it('keeps only account/inbox/conversation IDs and ignores currentAgent as authority', () => {
  const parsed = parseAppContext(JSON.stringify({ event: 'appContext', data: {
    conversation: { id: 20, account_id: 1, inbox_id: 31, messages: [{ content: 'private-text' }] },
    contact: { email: 'private@example.test' }, currentAgent: { id: 1, role: 'administrator' },
  } }));
  expect(parsed).toEqual({ accountId: 1, inboxId: 31, conversationId: 20 });
  expect(isContextGranted(parsed!, { accountId: 2, connections: [{ inboxId: 31 }] })).toBe(false);
  expect(isContextGranted(parsed!, { accountId: 1, connections: [{ inboxId: 99 }] })).toBe(false);
  expect(isContextGranted(parsed!, { accountId: 1, connections: [{ inboxId: 31 }] })).toBe(true);
});
it.each([null, 'broken', 'x'.repeat(65537), {}, { event: 'appContext', data: { currentAgent: { role: 'administrator' } } },
  { event: 'appContext', data: { conversation: { id: 1, inbox_id: -1, account_id: 1 } } },
  { event: 'other', data: { conversation: { id: 1, inbox_id: 1, account_id: 1 } } }])('refuses malformed or oversized context', value => {
  expect(parseAppContext(value)).toBeNull();
});
