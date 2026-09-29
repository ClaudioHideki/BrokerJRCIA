import { z } from 'zod';

export const DeletionPreviewSchema = z.strictObject({
  resourceId: z.uuid(),
  resourceName: z.string(),
  kind: z.enum(['CHANNEL','ORGANIZATION']),
  canDelete: z.boolean(),
  blockers: z.array(z.string()),
  counts: z.record(z.string(),z.number().int().nonnegative()),
  externalEffects: z.array(z.string()),
  operationId: z.uuid().nullable(),
  operationStatus: z.enum(['REQUESTED','BLOCKING','CLEANING_EXTERNAL','REMOVING_DATA','COMPLETED','ACTION_REQUIRED']).nullable(),
});

export const RequestDeletionSchema = z.strictObject({
  confirmationName: z.string().min(1).max(120),
  reason: z.string().trim().min(5).max(500),
});

export const DeletionRequestedSchema = z.strictObject({
  operationId: z.uuid(),
  status: z.enum(['REQUESTED','BLOCKING','CLEANING_EXTERNAL','REMOVING_DATA','COMPLETED','ACTION_REQUIRED']),
});

export const DeletionStatusSchema = DeletionRequestedSchema.extend({
  errorCode: z.string().nullable(),
  updatedAt: z.iso.datetime({offset:true}),
});
