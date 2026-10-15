import { z } from 'zod';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative();
export const NicoExternalActorSchema = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
export const NicoTakeoverSnapshotSchema = z.strictObject({
  organizationId: z.uuid(), integrationId: z.uuid(), channelId: z.uuid(), conversationId: z.uuid(),
  accountId: id, inboxId: id, remoteConversationId: id, remoteContactId: id,
  ownerRevision: revision, attendanceRevision: revision, controlRevision: revision,
  destinationRevision: revision, credentialRevision: revision, mode: z.enum(['BOT', 'HUMAN']),
});
export const NicoTakeoverRequestSchema = z.strictObject({
  requestId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expectedOwnerRevision: revision, expectedAttendanceRevision: revision, expectedControlRevision: revision,
  expectedDestinationRevision: revision, expectedCredentialRevision: revision,
});
export const NicoTakeoverCancelSchema = NicoTakeoverRequestSchema.pick({ requestId: true, fingerprint: true });
export const NicoTakeoverCompleteSchema = z.strictObject({ messageId: id });
export const NicoTakeoverOperationSchema = NicoTakeoverSnapshotSchema.extend({
  id: z.uuid(), requestId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['DRAINING', 'PAUSED', 'STALE', 'COMPLETED', 'CANCELED']),
});
export type NicoTakeoverSnapshot = z.infer<typeof NicoTakeoverSnapshotSchema>;
export type NicoTakeoverRequest = z.infer<typeof NicoTakeoverRequestSchema>;
export type NicoTakeoverOperation = z.infer<typeof NicoTakeoverOperationSchema>;
