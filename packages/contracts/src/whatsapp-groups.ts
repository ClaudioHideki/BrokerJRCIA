import { z } from 'zod';

// These are local catalog/page limits, independent of the provider's API.
export const WHATSAPP_GROUP_CATALOG_MAX_ITEMS = 2_000;
export const WHATSAPP_GROUP_CATALOG_MAX_PAGE_ITEMS = 100;
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const groupJid = z.string().max(128).regex(/^\d+(?:-\d+)?@g\.us$/u);
// Opaque, channel-scoped server HMAC with a dedicated use domain. This shape
// neither computes identity evidence nor authorizes a client-supplied value.
const identityFingerprint = z.string().regex(/^[a-f0-9]{64}$/u);

export const WhatsAppGroupCatalogScopeSchema = z.strictObject({
  provider: z.literal('QR'), organizationId: z.uuid(), channelId: z.uuid(),
  identityRevision: revision, identityFingerprint,
});

export const WhatsAppGroupCatalogItemSchema = z.strictObject({
  groupJid, subject: z.string().min(1).max(256).refine(value => value.trim().length > 0),
  participantCount: z.number().int().nonnegative().max(100_000),
  restrict: z.boolean().nullable(), announce: z.boolean().nullable(),
  isCommunity: z.boolean().nullable(), isCommunityAnnounce: z.boolean().nullable(),
  linkedParent: groupJid.nullable(), selected: z.boolean().default(false),
  automationEnabled: z.literal(false).default(false),
});

export const WhatsAppGroupCatalogSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), scope: WhatsAppGroupCatalogScopeSchema,
  snapshotId: z.uuid(), catalogRevision: revision, observedAt: z.iso.datetime(),
  status: z.enum(['CURRENT', 'STALE']), lastAttemptAt: z.iso.datetime(),
  lastErrorCode: z.enum([
    'PROVIDER_ABORTED', 'PROVIDER_TIMEOUT', 'PROVIDER_REQUEST_FAILED',
    'PROVIDER_INVALID_RESPONSE', 'IDENTITY_CHANGED', 'LEASE_LOST',
  ]).nullable(),
}).superRefine((value, ctx) => {
  if (value.status === 'CURRENT' && value.lastErrorCode !== null) {
    ctx.addIssue({ code: 'custom', message: 'A failed refresh cannot assert a current snapshot' });
  }
});

const cursor = z.strictObject({ snapshotId: z.uuid(), afterGroupJid: groupJid });
export const WhatsAppGroupCatalogPageQuerySchema = z.strictObject({
  limit: z.number().int().positive().max(WHATSAPP_GROUP_CATALOG_MAX_PAGE_ITEMS).default(50),
  cursor: cursor.optional(),
});

export const WhatsAppGroupCatalogPageSchema = z.strictObject({
  snapshot: WhatsAppGroupCatalogSnapshotSchema,
  items: z.array(WhatsAppGroupCatalogItemSchema).max(WHATSAPP_GROUP_CATALOG_MAX_PAGE_ITEMS),
  total: z.number().int().nonnegative().max(WHATSAPP_GROUP_CATALOG_MAX_ITEMS),
  nextCursor: cursor.nullable(),
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.items.length > value.total) invalid('Page exceeds the snapshot total');
  if (new Set(value.items.map(item => item.groupJid)).size !== value.items.length) invalid('Duplicate group in page');
  if (value.nextCursor && (value.nextCursor.snapshotId !== value.snapshot.snapshotId
    || value.nextCursor.afterGroupJid !== value.items.at(-1)?.groupJid)) {
    invalid('Cursor must continue the same snapshot after the final item');
  }
});

// Server handlers must resolve the tenant/channel's own snapshot and revalidate
// lease, revisions and observed identity after I/O. These are expectations,
// never a grant, and G1 selection admits neither sending nor automation.
export const UpdateWhatsAppGroupSelectionSchema = z.strictObject({
  expectedSnapshotId: z.uuid(), expectedCatalogRevision: revision,
  expectedIdentityRevision: revision, expectedIdentityFingerprint: identityFingerprint,
  groupJid, enabled: z.boolean(),
});

export type WhatsAppGroupCatalogScope = z.infer<typeof WhatsAppGroupCatalogScopeSchema>;
export type WhatsAppGroupCatalogItem = z.infer<typeof WhatsAppGroupCatalogItemSchema>;
export type WhatsAppGroupCatalogSnapshot = z.infer<typeof WhatsAppGroupCatalogSnapshotSchema>;
export type WhatsAppGroupCatalogPageQuery = z.infer<typeof WhatsAppGroupCatalogPageQuerySchema>;
export type WhatsAppGroupCatalogPage = z.infer<typeof WhatsAppGroupCatalogPageSchema>;
export type UpdateWhatsAppGroupSelection = z.infer<typeof UpdateWhatsAppGroupSelectionSchema>;
