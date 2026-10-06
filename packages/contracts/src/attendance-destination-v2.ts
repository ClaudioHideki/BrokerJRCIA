import { z } from 'zod';

/** Local authority has no Account/Inbox or remote credential identity. */
export const LocalAttendanceScopeV2Schema=z.strictObject({
 kind:z.literal('LOCAL'),organizationId:z.uuid(),channelId:z.uuid(),
});
export type LocalAttendanceScopeV2=z.infer<typeof LocalAttendanceScopeV2Schema>;
export const LocalHumanTargetSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('QUEUE')}),
 z.strictObject({kind:z.literal('TEAM'),teamId:z.uuid()}),
 z.strictObject({kind:z.literal('AGENT'),agentId:z.uuid()}),
]);
export type LocalHumanTarget=z.infer<typeof LocalHumanTargetSchema>;
export const LocalAttendanceDirectorySchema=z.strictObject({
 scope:LocalAttendanceScopeV2Schema,
 agents:z.array(z.strictObject({id:z.uuid(),email:z.email().max(320),role:z.enum(['OWNER','ADMIN','OPERATOR'])})).max(1000),
 teams:z.array(z.strictObject({id:z.uuid(),name:z.string().min(1).max(120),revision:z.int().positive(),memberIds:z.array(z.uuid()).min(1).max(1000)})).max(1000),
});
export type LocalAttendanceDirectory=z.infer<typeof LocalAttendanceDirectorySchema>;
export const LocalTeamViewSchema=z.strictObject({
 id:z.uuid(),name:z.string().min(1).max(120),status:z.enum(['ACTIVE','ARCHIVED']),revision:z.int().positive(),memberIds:z.array(z.uuid()).max(1000),
});
export type LocalTeamView=z.infer<typeof LocalTeamViewSchema>;
export const LocalTeamsViewSchema=z.strictObject({agents:LocalAttendanceDirectorySchema.shape.agents,teams:z.array(LocalTeamViewSchema).max(1000)});
const teamName=z.string().trim().min(1).max(120);
export const LocalTeamCreateSchema=z.strictObject({name:teamName});
export const LocalTeamUpdateSchema=z.strictObject({expectedRevision:z.int().positive(),name:teamName,status:z.enum(['ACTIVE','ARCHIVED'])});
export const LocalTeamMembersSchema=z.strictObject({expectedRevision:z.int().positive(),memberIds:z.array(z.uuid()).max(1000).refine(ids=>new Set(ids).size===ids.length)});
export const LocalAssignmentRequestSchema=z.strictObject({expectedSessionId:z.uuid(),sessionRevision:z.int().positive(),target:LocalHumanTargetSchema});
export const LocalQueueItemSchema=z.strictObject({
 conversationId:z.uuid(),sessionId:z.uuid(),sessionRevision:z.int().positive(),cycle:z.int().positive(),
 state:z.enum(['WAITING_HUMAN','HUMAN_ACTIVE']),target:LocalHumanTargetSchema,
});
export type LocalQueueItem=z.infer<typeof LocalQueueItemSchema>;
export const LocalQueueSchema=z.strictObject({scope:LocalAttendanceScopeV2Schema,data:z.array(LocalQueueItemSchema).max(1000)});
export const AutomationLocalHandoffConfigV2Schema=z.strictObject({
 handoffVersion:z.literal(2),destination:LocalAttendanceScopeV2Schema,target:LocalHumanTargetSchema,
});
export type AutomationLocalHandoffConfigV2=z.infer<typeof AutomationLocalHandoffConfigV2Schema>;
export const LocalAttendanceChannelsSchema=z.strictObject({data:z.array(z.strictObject({
 scope:LocalAttendanceScopeV2Schema,name:z.string().min(1).max(1000),
})).max(10000)});
