import {z} from 'zod';

/** Client attestation. Acceptance does not verify the client's physical storage. */
export const MediaCustodyRequestSchema=z.strictObject({
 schemaVersion:z.literal(1),channelId:z.uuid(),messageId:z.uuid(),mediaId:z.uuid(),
 endpointId:z.uuid(),destinationVersion:z.literal(1),clientReceiptId:z.uuid(),
 byteSize:z.number().int().min(1).max(16777216),sha256:z.string().regex(/^[a-f0-9]{64}$/u),
 storageObjectId:z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_./:-]+$/u).refine(value=>!value.includes('://')).describe('Opaque durable object reference; never a signed URL, token or secret'),
 attestation:z.literal('DURABLY_STORED'),
});
export const MediaCustodyReceiptSchema=MediaCustodyRequestSchema.extend({id:z.uuid(),organizationId:z.uuid(),acceptedAt:z.iso.datetime()});
export const MediaCustodyResponseSchema=z.strictObject({schemaVersion:z.literal(1),receipt:MediaCustodyReceiptSchema});
export const MediaCustodyRecordResponseSchema=MediaCustodyResponseSchema.extend({replayed:z.boolean()});
export const MediaCustodyRetentionSchema=z.strictObject({schemaVersion:z.literal(1),receiptId:z.uuid(),policy:z.literal('KEEP'),eligibleForDeletion:z.literal(false),reason:z.literal('KEEP_POLICY'),physicalStorageVerified:z.literal(false)});
export type MediaCustodyRequest=z.infer<typeof MediaCustodyRequestSchema>;
export type MediaCustodyReceipt=z.infer<typeof MediaCustodyReceiptSchema>;
