import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

const scope = {
  organizationId: '10000000-0000-4000-8000-000000000001',
  channelId: '10000000-0000-4000-8000-000000000002',
  integrationId: '10000000-0000-4000-8000-000000000003',
  destinationRevision: 1, accountId: 7, inboxId: 9,
};

describe('attendance contracts', () => {
  it('rejects incomplete or untrusted remote scopes', () => {
    expect(contracts.attendanceScopeSchema.safeParse(scope).success).toBe(true);
    for (const invalid of [{ ...scope, inboxId: 0 }, { ...scope, destinationRevision: 0 },
      { ...scope, accountId: Number.MAX_SAFE_INTEGER + 1 }, { ...scope, token: 'secret' }]) {
      expect(contracts.attendanceScopeSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('requires a human destination and rejects an implicit empty queue', () => {
    expect(contracts.humanTargetSchema.safeParse({ teamId: null, agentId: null }).success).toBe(false);
    expect(contracts.humanTargetSchema.parse({ teamId: 2, agentId: null })).toEqual({ teamId: 2, agentId: null });
    expect(contracts.humanTargetSchema.safeParse({ teamId: null, agentId: -1 }).success).toBe(false);
  });
  it('requires an explicit menu node when resuming to a menu', () => {
    expect(contracts.resumeTargetSchema.safeParse({ kind: 'MENU' }).success).toBe(false);
    expect(contracts.resumeTargetSchema.parse({ kind: 'CONTINUE' })).toEqual({ kind: 'CONTINUE' });
    expect(contracts.resumeTargetSchema.safeParse({ kind: 'NEW_SESSION', nodeId: 'stale' }).success).toBe(false);
  });
  it('keeps local ownership valid without manufacturing an integration', () => {
    expect(contracts.ownershipSchema.parse({ channelId: scope.channelId, integrationId: null,
      revision: 1, executor: 'NONE', automationId: null, version: null }).integrationId).toBeNull();
    expect(contracts.ownershipSchema.safeParse({ channelId: scope.channelId, integrationId: null,
      revision: 1, executor: 'EXTERNAL', automationId: scope.channelId, version: 1 }).success).toBe(false);
  });
});
