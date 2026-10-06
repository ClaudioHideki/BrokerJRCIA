import { expect,it } from 'vitest';
import { AutomationLocalHandoffConfigV2Schema, CompatibleAutomationHandoffConfigSchema, LocalAttendanceScopeV2Schema } from '../src/index.js';
const scope={kind:'LOCAL',organizationId:'11111111-1111-4111-8111-111111111111',channelId:'22222222-2222-4222-8222-222222222222'};
it('defines local scope without fake remote identifiers',()=>{
 expect(LocalAttendanceScopeV2Schema.parse(scope)).toEqual(scope);
 expect(LocalAttendanceScopeV2Schema.safeParse({...scope,accountId:1,inboxId:1}).success).toBe(false);
});
it('accepts only explicit versioned local queue handoff and preserves legacy reading',()=>{
 const data={handoffVersion:2,destination:scope,target:{kind:'QUEUE'}};
 expect(AutomationLocalHandoffConfigV2Schema.parse(data)).toEqual(data);
 expect(CompatibleAutomationHandoffConfigSchema.safeParse(data).success).toBe(true);
 expect(CompatibleAutomationHandoffConfigSchema.safeParse({...data,target:{teamId:1,agentId:null}}).success).toBe(false);
 expect(CompatibleAutomationHandoffConfigSchema.safeParse({}).success).toBe(true);
 expect(CompatibleAutomationHandoffConfigSchema.safeParse({...data,handoffVersion:3}).success).toBe(false);
});
