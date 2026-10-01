import { z } from 'zod';

const remoteId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const attendanceScopeSchema = z.strictObject({
  organizationId: z.uuid(), channelId: z.uuid(), integrationId: z.uuid(),
  destinationRevision: z.number().int().positive(), accountId: remoteId, inboxId: remoteId,
});
export type AttendanceScope = z.infer<typeof attendanceScopeSchema>;
export const attendanceStateSchema = z.enum([
  'BOT_ACTIVE', 'WAITING_INPUT', 'HANDOFF_PENDING', 'WAITING_HUMAN',
  'HUMAN_ACTIVE', 'RESOLVED', 'ADMIN_PAUSED',
]);
export type AttendanceState = z.infer<typeof attendanceStateSchema>;
export const ownershipSchema = z.strictObject({
  channelId: z.uuid(), integrationId: z.uuid().nullable(), revision: z.number().int().nonnegative(),
  executor: z.enum(['BROKER', 'EXTERNAL', 'NONE']),
  automationId: z.uuid().nullable(), version: z.number().int().positive().nullable(),
}).refine(value => (value.automationId === null) === (value.version === null)
  && (value.executor === 'BROKER' || value.automationId === null), 'Invalid executor version');
export type Ownership = z.infer<typeof ownershipSchema>;
export const attendanceSessionSchema = z.strictObject({
  id: z.uuid(), scope: attendanceScopeSchema, conversationId: z.uuid(),
  cycle: z.number().int().positive(), executionId: z.uuid().nullable(),
  automationId: z.uuid().nullable(), version: z.number().int().positive().nullable(),
  state: attendanceStateSchema, revision: z.number().int().positive(),
  ownerRevision: z.number().int().nonnegative(), remoteConversationId: remoteId.nullable(),
  resumeNodeId: z.string().min(1).max(100).nullable(),
}).refine(value => (value.automationId === null) === (value.version === null), 'Invalid session version');
export type AttendanceSession = z.infer<typeof attendanceSessionSchema>;
export const resumeTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('CONTINUE') }),
  z.strictObject({ kind: z.literal('MENU'), nodeId: z.string().min(1).max(100) }),
  z.strictObject({ kind: z.literal('NEW_SESSION') }),
]);
export type ResumeTarget = z.infer<typeof resumeTargetSchema>;
export const humanTargetSchema = z.strictObject({ teamId: remoteId.nullable(), agentId: remoteId.nullable() })
  .refine(value => value.teamId !== null || value.agentId !== null, 'Human destination required');
export type HumanTarget = z.infer<typeof humanTargetSchema>;
export const handoffOperationSchema = z.strictObject({
  id: z.uuid(), sessionId: z.uuid(), state: z.enum(['PENDING', 'APPLIED', 'UNKNOWN', 'ACTION_REQUIRED']),
});
export type HandoffOperation = z.infer<typeof handoffOperationSchema>;
