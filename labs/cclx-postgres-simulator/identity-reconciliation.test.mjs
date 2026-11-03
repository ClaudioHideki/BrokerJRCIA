import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePersistedIdentities } from './identity-reconciliation.mjs';

const expected = [
  { organizationId: 'tenant-a', eventId: 'same-event', sequence: 1, cursor: '1', bodyHash: 'a'.repeat(64) },
  { organizationId: 'tenant-b', eventId: 'same-event', sequence: 2, cursor: '2', bodyHash: 'b'.repeat(64) },
];
const inbox = expected.map(row => ({ ...row }));
const projections = expected.map(({ organizationId, eventId, sequence }) => ({ organizationId, eventId, sequence }));

test('reconciles colliding local IDs separately for each tenant', () => {
  const report = reconcilePersistedIdentities(expected, inbox, projections);
  assert.equal(report.reconciled, true);
  assert.deepEqual(report.tenants.map(row => [row.organizationId, row.expected, row.inbox, row.projections, row.reconciled]),
    [['tenant-a', 1, 1, 1, true], ['tenant-b', 1, 1, 1, true]]);
});

test('same aggregate counts cannot hide substituted or cross-tenant identities', () => {
  for (const corrupted of [
    [{ ...inbox[0], eventId: 'different-event' }, inbox[1]],
    [inbox[0], { ...inbox[1], organizationId: 'tenant-a' }],
  ]) {
    const report = reconcilePersistedIdentities(expected, corrupted, projections);
    assert.equal(report.reconciled, false);
    assert.equal(report.actualInbox, expected.length);
    assert.ok(report.missingInbox + report.unexpectedInbox + report.duplicateInbox > 0);
  }
});

test('checks stored body hash, cursor and sequence independently of row counts', () => {
  for (const mutation of [{ bodyHash: 'f'.repeat(64) }, { cursor: '7' }, { sequence: 7 }]) {
    const report = reconcilePersistedIdentities(expected, [{ ...inbox[0], ...mutation }, inbox[1]], projections);
    assert.equal(report.reconciled, false);
    assert.equal(report.invalidInbox, 1);
  }
  const report = reconcilePersistedIdentities(expected, inbox, [{ ...projections[0], sequence: 99 }, projections[1]]);
  assert.equal(report.reconciled, false);
  assert.equal(report.invalidProjections, 1);
  const withEnvelope = [{ ...expected[0], envelope: { organizationId: 'tenant-a', data: { sequence: 1 } } }];
  const wrongEnvelope = [{ ...withEnvelope[0], envelope: { organizationId: 'tenant-b', data: { sequence: 1 } } }];
  assert.equal(reconcilePersistedIdentities(withEnvelope, wrongEnvelope, [projections[0]]).invalidInbox, 1);
});

test('rejects an ambiguous expected manifest and detects missing/extra projections', () => {
  assert.throws(() => reconcilePersistedIdentities([expected[0], expected[0]], inbox, projections), /DUPLICATE_EXPECTED_IDENTITY/);
  const report = reconcilePersistedIdentities(expected, inbox, [projections[0], { ...projections[1], eventId: 'extra' }]);
  assert.equal(report.reconciled, false);
  assert.equal(report.missingProjections, 1);
  assert.equal(report.unexpectedProjections, 1);
});
