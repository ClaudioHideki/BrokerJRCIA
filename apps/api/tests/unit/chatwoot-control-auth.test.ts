import { expect, it } from 'vitest';
import { authorizeControlRequest } from '../../src/modules/integrations/chatwoot-control-auth.js';

const valid = { credential: { organizationId: 'a', scopes: ['chatwoot:pair'], revoked: false },
  binding: { organizationId: 'a', active: true, destinationRevision: 1 }, requestedOrganizationId: 'a', requiredScope: 'chatwoot:pair' };
it('requires exact scope, organization and active credential/binding', () => {
  expect(authorizeControlRequest(valid)).toBe(true);
  expect(authorizeControlRequest({ ...valid, requestedOrganizationId: 'b' })).toBe(false);
  expect(authorizeControlRequest({ ...valid, binding: { ...valid.binding, organizationId: 'b' } })).toBe(false);
  expect(authorizeControlRequest({ ...valid, credential: { ...valid.credential, revoked: true } })).toBe(false);
  expect(authorizeControlRequest({ ...valid, binding: { ...valid.binding, active: false } })).toBe(false);
  expect(authorizeControlRequest({ ...valid, credential: { ...valid.credential, scopes: ['instances:write'] }, requiredScope: 'chatwoot:manage' })).toBe(false);
});

it('keeps a managed reconnect credential operationally scoped', () => {
  const managed = { ...valid, credential: { ...valid.credential, scopes: ['chatwoot:read', 'chatwoot:pair'] } };
  expect(authorizeControlRequest({ ...managed, requiredScope: 'chatwoot:read' })).toBe(true);
  expect(authorizeControlRequest({ ...managed, requiredScope: 'chatwoot:pair' })).toBe(true);
  expect(authorizeControlRequest({ ...managed, requiredScope: 'chatwoot:disconnect' })).toBe(false);
  expect(authorizeControlRequest({ ...managed, requiredScope: 'chatwoot:manage' })).toBe(false);
});
