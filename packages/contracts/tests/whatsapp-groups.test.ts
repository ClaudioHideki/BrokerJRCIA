import { describe, expect, it } from 'vitest';
import {
  WhatsAppGroupCatalogItemSchema, WhatsAppGroupCatalogScopeSchema,
  WhatsAppGroupCatalogSnapshotSchema, WhatsAppGroupCatalogPageQuerySchema,
  WhatsAppGroupCatalogPageSchema, UpdateWhatsAppGroupSelectionSchema,
} from '../src/whatsapp-groups.js';

const org = '10000000-0000-4000-8000-000000000001';
const channel = '10000000-0000-4000-8000-000000000002';
const snapshotId = '10000000-0000-4000-8000-000000000003';
const otherSnapshotId = '10000000-0000-4000-8000-000000000004';
const groupJid = '120000000000001@g.us';
const scope = { provider: 'QR', organizationId: org, channelId: channel, identityRevision: 2, identityFingerprint: 'a'.repeat(64) };
const item = {
  groupJid, subject: 'Synthetic group', participantCount: 3,
  restrict: null, announce: false, isCommunity: null, isCommunityAnnounce: null, linkedParent: null,
};
const snapshot = {
  schemaVersion: 1, scope, snapshotId, catalogRevision: 4,
  observedAt: '2026-10-08T12:00:00.000Z', status: 'CURRENT',
  lastAttemptAt: '2026-10-08T12:00:00.000Z', lastErrorCode: null,
};
const selection = {
  expectedSnapshotId: snapshotId, expectedCatalogRevision: 4,
  expectedIdentityRevision: 2, expectedIdentityFingerprint: 'a'.repeat(64),
  groupJid, enabled: true,
};

describe('WhatsApp QR group catalog and opt-in (G1)', () => {
  it('scopes every snapshot to organization, channel and observed identity without a phone number', () => {
    expect(WhatsAppGroupCatalogScopeSchema.parse(scope)).toEqual(scope);
    expect(WhatsAppGroupCatalogSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(WhatsAppGroupCatalogScopeSchema.safeParse({ ...scope, phone: 'synthetic-private-identity' }).success).toBe(false);
    expect(WhatsAppGroupCatalogScopeSchema.safeParse({ ...scope, identityFingerprint: 'raw-identity' }).success).toBe(false);
  });

  it.each(['META', 'CENTRAL'])('does not declare group support for %s', (provider) => {
    expect(WhatsAppGroupCatalogScopeSchema.safeParse({ ...scope, provider }).success).toBe(false);
  });

  it('defaults selection and automation off, preserving absent provider flags as unknown', () => {
    expect(WhatsAppGroupCatalogItemSchema.parse(item)).toEqual({ ...item, selected: false, automationEnabled: false });
    expect(WhatsAppGroupCatalogItemSchema.safeParse({ ...item, automationEnabled: true }).success).toBe(false);
    expect(WhatsAppGroupCatalogItemSchema.safeParse({ ...item, announce: 'false' }).success).toBe(false);
    expect(WhatsAppGroupCatalogItemSchema.safeParse({ ...item, voiceSupported: true }).success).toBe(false);
  });

  it('represents explicit selected groups while keeping automation disabled', () => {
    expect(WhatsAppGroupCatalogItemSchema.parse({ ...item, selected: true })).toEqual({
      ...item, selected: true, automationEnabled: false,
    });
    expect(UpdateWhatsAppGroupSelectionSchema.parse(selection)).toEqual(selection);
    expect(UpdateWhatsAppGroupSelectionSchema.parse({ ...selection, enabled: false })).toEqual({ ...selection, enabled: false });
  });

  it.each([
    'synthetic@s.whatsapp.net', 'synthetic@lid', 'status@broadcast',
    '../120000000000001@g.us', '120000000000001@g.us?tenant=other',
  ])('rejects a recipient that is not an exact group JID (%#)', (badJid) => {
    expect(WhatsAppGroupCatalogItemSchema.safeParse({ ...item, groupJid: badJid }).success).toBe(false);
    expect(UpdateWhatsAppGroupSelectionSchema.safeParse({ ...selection, groupJid: badJid }).success).toBe(false);
  });

  it('requires an explicit decision and all snapshot/identity expectations for selection', () => {
    for (const key of ['enabled', 'expectedSnapshotId', 'expectedCatalogRevision', 'expectedIdentityRevision', 'expectedIdentityFingerprint'] as const) {
      const command: Record<string, unknown> = { ...selection };
      delete command[key];
      expect(UpdateWhatsAppGroupSelectionSchema.safeParse(command).success, key).toBe(false);
    }
    expect(UpdateWhatsAppGroupSelectionSchema.safeParse({ ...selection, enabled: 'true' }).success).toBe(false);
    expect(UpdateWhatsAppGroupSelectionSchema.safeParse({ ...selection, expectedIdentityRevision: 0 }).success).toBe(false);
    expect(UpdateWhatsAppGroupSelectionSchema.safeParse({ ...selection, expectedCatalogRevision: 1.5 }).success).toBe(false);
  });

  it.each(['organizationId', 'channelId', 'provider', 'apiKey', 'instanceKey', 'baseUrl', 'automationEnabled', 'send']) (
    'does not accept client authority, a URI/provider credential or sending field %s', (key) => {
      expect(UpdateWhatsAppGroupSelectionSchema.safeParse({ ...selection, [key]: 'synthetic' }).success).toBe(false);
      expect(WhatsAppGroupCatalogPageQuerySchema.safeParse({ [key]: 'synthetic' }).success).toBe(false);
    },
  );

  it('supports only local snapshot-bound pagination with a maximum of 100 items', () => {
    expect(WhatsAppGroupCatalogPageQuerySchema.parse({})).toEqual({ limit: 50 });
    const cursor = { snapshotId, afterGroupJid: groupJid };
    expect(WhatsAppGroupCatalogPageQuerySchema.parse({ limit: 100, cursor })).toEqual({ limit: 100, cursor });
    for (const limit of [0, -1, 101, 1.5, '100']) {
      expect(WhatsAppGroupCatalogPageQuerySchema.safeParse({ limit }).success).toBe(false);
    }
    expect(WhatsAppGroupCatalogPageQuerySchema.safeParse({ page: 2 }).success).toBe(false);
    expect(WhatsAppGroupCatalogPageQuerySchema.safeParse({ getParticipants: true }).success).toBe(false);
    expect(WhatsAppGroupCatalogPageQuerySchema.safeParse({ cursor: { afterGroupJid: groupJid } }).success).toBe(false);
  });

  it('represents a preserved stale snapshot after refresh failure, rather than asserting a fresh empty catalog', () => {
    const stale = {
      ...snapshot, status: 'STALE', lastAttemptAt: '2026-10-08T12:01:00.000Z',
      lastErrorCode: 'PROVIDER_TIMEOUT',
    };
    expect(WhatsAppGroupCatalogPageSchema.parse({ snapshot: stale, items: [item], total: 1, nextCursor: null })).toEqual({
      snapshot: stale, items: [{ ...item, selected: false, automationEnabled: false }], total: 1, nextCursor: null,
    });
    expect(WhatsAppGroupCatalogSnapshotSchema.safeParse({ ...stale, status: 'CURRENT' }).success).toBe(false);
  });

  it('rejects contradictory local pages and cursors from a different snapshot', () => {
    expect(WhatsAppGroupCatalogPageSchema.safeParse({ snapshot, items: [item], total: 0, nextCursor: null }).success).toBe(false);
    expect(WhatsAppGroupCatalogPageSchema.safeParse({ snapshot, items: [], total: 2001, nextCursor: null }).success).toBe(false);
    expect(WhatsAppGroupCatalogPageSchema.safeParse({ snapshot, items: [item], total: 2,
      nextCursor: { snapshotId: otherSnapshotId, afterGroupJid: groupJid } }).success).toBe(false);
    expect(WhatsAppGroupCatalogPageSchema.safeParse({ snapshot, items: [item, item], total: 2, nextCursor: null }).success).toBe(false);
    const oversizedItems = Array.from({ length: 101 }, (_, index) => ({
      ...item, groupJid: `${120000000000001n + BigInt(index)}@g.us`,
    }));
    expect(WhatsAppGroupCatalogPageSchema.safeParse({ snapshot, items: oversizedItems, total: 101, nextCursor: null }).success).toBe(false);
  });

  it('does not expose unobserved participant data, media destinations, engine configuration or arbitrary fields', () => {
    for (const key of ['participants', 'owner', 'pictureUrl', 'description', 'token', 'sendAllowed']) {
      expect(WhatsAppGroupCatalogItemSchema.safeParse({ ...item, [key]: 'synthetic-private-data' }).success, key).toBe(false);
    }
    expect(WhatsAppGroupCatalogSnapshotSchema.safeParse({ ...snapshot, providerVersion: 'unverified-installed' }).success).toBe(false);
  });
});
