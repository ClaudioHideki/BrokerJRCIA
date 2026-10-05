import { z } from 'zod';
import { resumeTargetSchema } from './attendance-v1.js';
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ResumeAttendanceRequestSchema = z.strictObject({
  expectedControlRevision: revision, expectedOwnerRevision: revision, target: resumeTargetSchema,
});
export type ResumeAttendanceRequest = z.infer<typeof ResumeAttendanceRequestSchema>;
export type ResumeAttendanceInput = ResumeAttendanceRequest & { conversationId: string };
export const ResumeOperationStateSchema = z.enum(['PENDING', 'APPLIED', 'UNKNOWN', 'ACTION_REQUIRED', 'CANCELED']);
export type ResumeOperationState = z.infer<typeof ResumeOperationStateSchema>;
export const ResumeOperationViewSchema = z.strictObject({
  id: z.uuid(), state: ResumeOperationStateSchema, conversationId: z.uuid(), sessionId: z.uuid().nullable(),
  errorCode: z.string().min(1).max(120).nullable(),
});
export type ResumeOperationView = z.infer<typeof ResumeOperationViewSchema>;
export const AttendanceDiagnosticSchema = z.strictObject({
  allowed:z.boolean(),reason:z.enum(['NONE','HUMAN_CONTROL','REMOTE_INITIALIZING','REMOTE_RECONCILE','REMOTE_PAUSED','LOCAL_HUMAN','SCOPE_CHANGED','OWNER_CHANGED','SESSION_PAUSED']),
  controlRevision:revision,cycle:z.number().int().positive().nullable(),
});
export type AttendanceDiagnostic = z.infer<typeof AttendanceDiagnosticSchema>;
export const AttendanceResumeContextSchema = z.strictObject({
  diagnostic:AttendanceDiagnosticSchema,ownerRevision:revision,hasActiveSession:z.boolean(),hasCompatibleCursor:z.boolean(),
  menuNodes:z.array(z.strictObject({id:z.string().min(1).max(100),label:z.string().max(1000)})).max(500),
  operation:ResumeOperationViewSchema.nullable(),
});
export type AttendanceResumeContext = z.infer<typeof AttendanceResumeContextSchema>;
