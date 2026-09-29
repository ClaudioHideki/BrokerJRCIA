import { expect, it } from 'vitest';
import { assertSupportWrite, supportStatusAfterReply } from '../../src/modules/support/service.js';

it('allows JRC agents and tenant operators to respond but rejects tenant viewers', () => {
  expect(() => assertSupportWrite({ kind: 'TENANT', actorId: 'reader', organizationId: 'org', canWrite: false })).toThrow('SUPPORT_FORBIDDEN');
  expect(() => assertSupportWrite({ kind: 'TENANT', actorId: 'admin', organizationId: 'org', canWrite: true })).not.toThrow();
  expect(() => assertSupportWrite({ kind: 'PLATFORM', actorId: 'staff' })).not.toThrow();
});

it('routes client replies back to JRC and staff replies back to the client', () => {
  expect(supportStatusAfterReply('TENANT')).toBe('OPEN');
  expect(supportStatusAfterReply('PLATFORM')).toBe('WAITING_CUSTOMER');
});
