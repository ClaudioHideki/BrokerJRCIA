import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';
import { HistoryImportSelectionSchema } from '../src/history-import.js';

const id = '10000000-0000-4000-8000-000000000001';
const start = { mode: 'FULL_AVAILABLE', categories: ['INDIVIDUAL', 'GROUP', 'MEDIA'] };
const schema = (name: string) => {
  const result = (contracts as Record<string, unknown>)[name];
  expect(result, `${name} is a versioned, exported contract`).toBeDefined();
  return result as { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } };
};
const status = () => ({
  schemaVersion: 2, id, organizationId: id, channelId: id, instanceId: id, revision: 1,
  state: 'RUNNING', capture: 'CAPTURING', persistence: 'RUNNING', projection: 'PENDING',
  sourceTotalKnown: false, counts: { chats: 1, capturedMessages: 2, persistedMessages: 1,
    duplicateMessages: 0, projectedMessages: 0, pendingMedia: 1, verifiedMedia: 0,
    unavailableMedia: 0, blockedRecords: 0 }, lastError: null,
});

describe('history sync V2 public boundary', () => {
  it('admits the complete declared coverage without changing V1', () => {
    expect(schema('HistorySyncStartSchema').parse(start)).toEqual(start);
    expect(HistoryImportSelectionSchema.safeParse(start).success).toBe(false);
  });
  it.each(['engineUrl', 'credential', 'ownerFingerprint', 'manifest'])('rejects browser supplied %s', field => {
    expect(schema('HistorySyncStartSchema').safeParse({ ...start, [field]: 'untrusted' }).success).toBe(false);
  });
  it('requires distinct, bounded categories and does not accept arbitrary import modes', () => {
    const s = schema('HistorySyncStartSchema');
    for (const value of [{ ...start, categories: [] }, { ...start, categories: ['GROUP', 'GROUP'] },
      { ...start, categories: ['ALL'] }, { ...start, categories: ['MEDIA'] }, { ...start, mode: 'REPLAY_UNKNOWN' }]) {
      expect(s.safeParse(value).success).toBe(false);
    }
  });
  it('separates source capture, local persistence and consumer projection', () => {
    expect(schema('HistorySyncStatusSchema').parse(status())).toEqual(status());
  });
  it('cannot claim completion with a pending consumer or pending media', () => {
    const s = schema('HistorySyncStatusSchema');
    expect(s.safeParse({ ...status(), state: 'COMPLETED' }).success).toBe(false);
    const complete = { ...status(), state: 'COMPLETED', capture: 'COMPLETE', persistence: 'COMPLETE', projection: 'COMPLETE',
      counts: { ...status().counts, persistedMessages: 2, projectedMessages: 2, pendingMedia: 0, verifiedMedia: 1 } };
    expect(s.safeParse(complete).success).toBe(true);
    expect(s.safeParse({ ...complete, counts: { ...complete.counts, pendingMedia: 1 } }).success).toBe(false);
    expect(s.safeParse({ ...complete, counts: { ...complete.counts, unavailableMedia: 1 } }).success).toBe(false);
  });
  it('allows standalone Broker completion without pretending a consumer exists', () => {
    const value = { ...status(), state: 'COMPLETED', capture: 'COMPLETE', persistence: 'COMPLETE', projection: 'NOT_CONFIGURED',
      counts: { ...status().counts, persistedMessages: 2, pendingMedia: 0, verifiedMedia: 1 } };
    expect(schema('HistorySyncStatusSchema').safeParse(value).success).toBe(true);
  });
  it('rejects contradictory counters, unsafe integers and leaked private scope', () => {
    const s = schema('HistorySyncStatusSchema');
    for (const patch of [{ ownerFingerprint: 'private' }, { instanceKey: 'private' },
      { counts: { ...status().counts, persistedMessages: 3 } },
      { counts: { ...status().counts, duplicateMessages: 2 } },
      { counts: { ...status().counts, projectedMessages: 2 } },
      { counts: { ...status().counts, chats: Number.MAX_SAFE_INTEGER + 1 } }, { lastError: 'raw exception / request payload' }]) {
      expect(s.safeParse({ ...status(), ...patch }).success).toBe(false);
    }
  });
  it('requires an expected revision for resume/cancel without adding new authority', () => {
    const s = schema('HistorySyncCommandSchema');
    expect(s.parse({ expectedRevision: 1 })).toEqual({ expectedRevision: 1 });
    expect(s.safeParse({ expectedRevision: 0 }).success).toBe(false);
    expect(s.safeParse({ expectedRevision: 1, role: 'OWNER' }).success).toBe(false);
  });
});
