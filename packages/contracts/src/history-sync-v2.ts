import { z } from 'zod';

const id = z.uuid();
const count = z.number().int().nonnegative().safe();
export const HistorySyncCategorySchema = z.enum(['INDIVIDUAL', 'GROUP', 'MEDIA']);
export const HistorySyncStartSchema = z.strictObject({
  mode: z.literal('FULL_AVAILABLE'),
  categories: z.array(HistorySyncCategorySchema).min(1).max(3)
    .refine(values => new Set(values).size === values.length, 'Duplicate coverage')
    .refine(values => values.includes('INDIVIDUAL') || values.includes('GROUP'), 'Select a chat category; media is additional coverage'),
});
export const HistorySyncCommandSchema = z.strictObject({ expectedRevision: count.positive() });
export const HistorySyncCountsSchema = z.strictObject({
  chats: count, capturedMessages: count, persistedMessages: count, duplicateMessages: count,
  projectedMessages: count, pendingMedia: count, verifiedMedia: count, unavailableMedia: count,
  blockedRecords: count,
}).refine(value => value.persistedMessages + value.duplicateMessages <= value.capturedMessages
  && value.projectedMessages <= value.persistedMessages, 'Inconsistent progress');

/** Public progress is not a source receipt and never carries private engine scope. */
export const HistorySyncStatusSchema = z.strictObject({
  schemaVersion: z.literal(2), id, organizationId: id, channelId: id, instanceId: id,
  revision: count.positive(), state: z.enum(['RUNNING', 'PAUSED', 'CANCELED', 'COMPLETED', 'PARTIAL', 'BLOCKED']),
  capture: z.enum(['WAITING_IDENTITY', 'CAPTURING', 'COMPLETE', 'PARTIAL', 'BLOCKED']),
  persistence: z.enum(['PENDING', 'RUNNING', 'COMPLETE', 'BLOCKED']),
  projection: z.enum(['NOT_CONFIGURED', 'PENDING', 'RUNNING', 'COMPLETE', 'BLOCKED']),
  sourceTotalKnown: z.boolean(), counts: HistorySyncCountsSchema,
  lastError: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u).nullable(),
}).refine(value => value.state !== 'COMPLETED' || (
  value.capture === 'COMPLETE' && value.persistence === 'COMPLETE'
  && ['COMPLETE', 'NOT_CONFIGURED'].includes(value.projection)
  && value.counts.persistedMessages + value.counts.duplicateMessages === value.counts.capturedMessages
  && (value.projection !== 'COMPLETE' || value.counts.projectedMessages === value.counts.persistedMessages)
  && value.counts.pendingMedia === 0 && value.counts.unavailableMedia === 0 && value.counts.blockedRecords === 0
), 'Incomplete synchronization cannot be completed');

export const HistorySyncCapabilitySchema = z.strictObject({
  schemaVersion: z.literal(2), organizationId: id, channelId: id, instanceId: id,
  available: z.boolean(), supportedCategories: z.array(HistorySyncCategorySchema).max(3),
  automatic: z.boolean(), coverage: z.enum(['UNKNOWN', 'PARTIAL', 'AVAILABLE']),
  reason: z.enum(['DISABLED', 'SOURCE_UNAVAILABLE', 'IDENTITY_NOT_VERIFIED', 'DESTINATION_UNSUPPORTED']).nullable(),
}).refine(value => value.available ? value.reason === null && value.supportedCategories.length > 0 : value.reason !== null,
  'Inconsistent capability');

export type HistorySyncCategory = z.infer<typeof HistorySyncCategorySchema>;
export type HistorySyncStart = z.infer<typeof HistorySyncStartSchema>;
export type HistorySyncStatus = z.infer<typeof HistorySyncStatusSchema>;
export type HistorySyncCounts = z.infer<typeof HistorySyncCountsSchema>;
export type HistorySyncCapability = z.infer<typeof HistorySyncCapabilitySchema>;

/** Read-only view. Absence of a run does not admit capture or authorize replay. */
export const HistorySyncProgressSchema=z.strictObject({schemaVersion:z.literal(2),organizationId:id,channelId:id,
  run:HistorySyncStatusSchema.nullable()}).refine(value=>value.run===null || (value.run.organizationId===value.organizationId
    && value.run.channelId===value.channelId),'Progress belongs to another tenant or channel');
export type HistorySyncProgress=z.infer<typeof HistorySyncProgressSchema>;
export const HistorySyncControlProgressSchema=HistorySyncProgressSchema.safeExtend({integrationId:id,accountId:count.positive(),
  inboxId:count.positive(),destinationRevision:count.positive()});
