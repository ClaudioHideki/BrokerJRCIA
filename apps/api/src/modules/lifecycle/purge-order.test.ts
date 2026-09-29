import { expect, it } from 'vitest';
import { planTenantPurgeOrder } from './purge-order.js';

it('deletes referencing tenant tables before their parents', () => {
  const order = planTenantPurgeOrder(
    ['provider_accounts', 'instances', 'provider_operations', 'chatwoot_connections'],
    [
      { child: 'instances', parent: 'provider_accounts', deferrable: false },
      { child: 'provider_operations', parent: 'instances', deferrable: false },
      { child: 'chatwoot_connections', parent: 'instances', deferrable: false },
    ],
  );
  expect(order.indexOf('provider_operations')).toBeLessThan(order.indexOf('instances'));
  expect(order.indexOf('chatwoot_connections')).toBeLessThan(order.indexOf('instances'));
  expect(order.indexOf('instances')).toBeLessThan(order.indexOf('provider_accounts'));
});

it('ignores deferrable self references and refuses unexpected nondeferrable cycles', () => {
  expect(planTenantPurgeOrder(['refresh_tokens'], [{ child: 'refresh_tokens', parent: 'refresh_tokens', deferrable: true }]))
    .toEqual(['refresh_tokens']);
  expect(() => planTenantPurgeOrder(['a', 'b'], [
    { child: 'a', parent: 'b', deferrable: false },
    { child: 'b', parent: 'a', deferrable: false },
  ])).toThrow('TENANT_PURGE_CYCLE');
});

it('rejects a catalogue entry outside public simple table identifiers', () => {
  expect(() => planTenantPurgeOrder(['users;drop table users'], [])).toThrow('TENANT_PURGE_CATALOGUE_INVALID');
});
