import { z } from 'zod';

/** Local authority has no Account/Inbox or remote credential identity. */
export const LocalAttendanceScopeV2Schema=z.strictObject({
 kind:z.literal('LOCAL'),organizationId:z.uuid(),channelId:z.uuid(),
});
export type LocalAttendanceScopeV2=z.infer<typeof LocalAttendanceScopeV2Schema>;
export const AutomationLocalHandoffConfigV2Schema=z.strictObject({
 handoffVersion:z.literal(2),destination:LocalAttendanceScopeV2Schema,target:z.strictObject({kind:z.literal('QUEUE')}),
});
export type AutomationLocalHandoffConfigV2=z.infer<typeof AutomationLocalHandoffConfigV2Schema>;
export const LocalAttendanceChannelsSchema=z.strictObject({data:z.array(z.strictObject({
 scope:LocalAttendanceScopeV2Schema,name:z.string().min(1).max(1000),
})).max(10000)});
