import { isDeepStrictEqual } from 'node:util';

const key = row => JSON.stringify([row.organizationId, row.eventId]);

function compare(expected, observed, fields) {
  const expectedById = new Map(expected.map(row => [key(row), row]));
  const observedIds = new Set();
  let unexpected = 0, duplicates = 0, invalid = 0;
  for (const row of observed) {
    const id = key(row), wanted = expectedById.get(id);
    if (observedIds.has(id)) duplicates++;
    observedIds.add(id);
    if (!wanted) unexpected++;
    else if (fields.some(field => !isDeepStrictEqual(row[field], wanted[field]))) invalid++;
  }
  const missing = [...expectedById.keys()].filter(id => !observedIds.has(id)).length;
  return { missing, unexpected, duplicates, invalid };
}

function summarize(expected, inbox, projections) {
  const a = compare(expected, inbox, ['bodyHash', 'cursor', 'sequence', 'envelope']);
  const b = compare(expected, projections, ['sequence']);
  return {
    reconciled: [...Object.values(a), ...Object.values(b)].every(value => value === 0),
    expectedUnique: expected.length, actualInbox: inbox.length, actualProjections: projections.length,
    missingInbox: a.missing, unexpectedInbox: a.unexpected, duplicateInbox: a.duplicates, invalidInbox: a.invalid,
    missingProjections: b.missing, unexpectedProjections: b.unexpected,
    duplicateProjections: b.duplicates, invalidProjections: b.invalid,
  };
}

/** Independent manifest-versus-SQL audit, not an ACK/count-based success claim. */
export function reconcilePersistedIdentities(expected, inbox, projections) {
  if (new Set(expected.map(key)).size !== expected.length) throw Error('DUPLICATE_EXPECTED_IDENTITY');
  const organizations = [...new Set([...expected, ...inbox, ...projections].map(row => row.organizationId))].sort();
  return { ...summarize(expected, inbox, projections), tenants: organizations.map(organizationId => {
    const rows = list => list.filter(row => row.organizationId === organizationId);
    const result = summarize(rows(expected), rows(inbox), rows(projections));
    return { organizationId, expected: result.expectedUnique, inbox: result.actualInbox,
      projections: result.actualProjections, ...result };
  }) };
}
