import { expect,it } from 'vitest';
import { AutomationLocalHandoffConfigV2Schema, CompatibleAutomationHandoffConfigSchema, LocalAttendanceScopeV2Schema } from '../src/index.js';
import * as contracts from '../src/index.js';
const scope={kind:'LOCAL',organizationId:'11111111-1111-4111-8111-111111111111',channelId:'22222222-2222-4222-8222-222222222222'};
it('defines local scope without fake remote identifiers',()=>{
 expect(LocalAttendanceScopeV2Schema.parse(scope)).toEqual(scope);
 expect(LocalAttendanceScopeV2Schema.safeParse({...scope,accountId:1,inboxId:1}).success).toBe(false);
});
it('models local human targets with UUIDs and excludes remote numeric identities',()=>{
 const schema=(contracts as unknown as {LocalHumanTargetSchema:{safeParse(value:unknown):{success:boolean}}}).LocalHumanTargetSchema;
 expect(schema,'local human target schema').toBeDefined();
 for(const target of [{kind:'QUEUE'},{kind:'TEAM',teamId:scope.organizationId},{kind:'AGENT',agentId:scope.channelId}])expect(schema.safeParse(target).success).toBe(true);
 for(const target of [{kind:'TEAM',teamId:7},{kind:'AGENT',agentId:9},{kind:'TEAM',teamId:scope.organizationId,agentId:scope.channelId},{kind:'QUEUE',agentId:scope.channelId}])expect(schema.safeParse(target).success).toBe(false);
});
it('accepts only explicit versioned local queue handoff and preserves legacy reading',()=>{
 const data={handoffVersion:2,destination:scope,target:{kind:'QUEUE'}};
 expect(AutomationLocalHandoffConfigV2Schema.parse(data)).toEqual(data);
 expect(CompatibleAutomationHandoffConfigSchema.safeParse(data).success).toBe(true);
 expect(CompatibleAutomationHandoffConfigSchema.safeParse({...data,target:{teamId:1,agentId:null}}).success).toBe(false);
 expect(CompatibleAutomationHandoffConfigSchema.safeParse({}).success).toBe(true);
 expect(CompatibleAutomationHandoffConfigSchema.safeParse({...data,handoffVersion:3}).success).toBe(false);
});
it('accepts explicit local TEAM and AGENT handoff without converting remote IDs',()=>{
 for(const target of [{kind:'TEAM',teamId:scope.organizationId},{kind:'AGENT',agentId:scope.channelId}]){
  const value={handoffVersion:2,destination:scope,target};
  expect(AutomationLocalHandoffConfigV2Schema.safeParse(value).success).toBe(true);
  expect(CompatibleAutomationHandoffConfigSchema.safeParse(value).success).toBe(true);
 }
 expect(AutomationLocalHandoffConfigV2Schema.safeParse({handoffVersion:2,destination:scope,target:{kind:'AGENT',agentId:9}}).success).toBe(false);
});
