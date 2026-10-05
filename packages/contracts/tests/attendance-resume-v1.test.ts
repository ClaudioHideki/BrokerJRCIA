import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

const id = '10000000-0000-4000-8000-000000000001';
describe('coordinated attendance resume contracts', () => {
  it('requires revisions and an explicit target, with identity only in the authenticated context', () => {
    const body = { expectedControlRevision: 8, expectedOwnerRevision: 1, target: { kind: 'NEW_SESSION' } };
    expect(contracts.ResumeAttendanceRequestSchema.parse(body)).toEqual(body);
    for (const invalid of [{ ...body, organizationId: id }, { ...body, actorId: id },
      { ...body, expectedControlRevision: -1 }, { ...body, target: { kind: 'MENU' } },
      { ...body, expectedOwnerRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(contracts.ResumeAttendanceRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('keeps pending/uncertain operations distinct from confirmed bot activation', () => {
    const operation = { id, conversationId: id, state: 'UNKNOWN', sessionId: null, errorCode: 'REMOTE_RESULT_UNKNOWN' };
    expect(contracts.ResumeOperationViewSchema.parse(operation)).toEqual(operation);
    expect(contracts.ResumeOperationViewSchema.safeParse({ ...operation, token: 'private' }).success).toBe(false);
    expect(contracts.ResumeOperationViewSchema.safeParse({ ...operation, state: 'BOT' }).success).toBe(false);
  });
});
