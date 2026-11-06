import {expect,it} from 'vitest';
import {DomainCommandArgumentsSchema,DomainCommandConfigSchema,DomainCommandResultSchema} from '@jrc/contracts';

const episode='11111111-1111-4111-8111-111111111111';
const input={system:'example',location:'south',reason:'request',subject:'access',profile:'requester',
 identifier:'12345678901',email:'synthetic@example.invalid',description:'Synthetic request'};
const args={command:'service_desk_intake',configuration_id:7,configuration_revision:2,episode_key:episode,phase:'qualified',input};
const shared={conversationEffectVersion:2,operation:'domain',channelId:episode,target:'intake.result',timeoutMs:15000};

it('admits scoped intake and status without a CRM owner or arbitrary remote identifiers',()=>{
 expect(DomainCommandArgumentsSchema.safeParse(args).success).toBe(true);
 expect(DomainCommandArgumentsSchema.safeParse({command:'service_desk_status',episode_key:episode}).success).toBe(true);
 expect(DomainCommandArgumentsSchema.safeParse({...args,entity_id:99}).success).toBe(false);
 expect(DomainCommandArgumentsSchema.safeParse({...args,input:{...input,glpi_user_id:99}}).success).toBe(false);
 expect(DomainCommandArgumentsSchema.safeParse({...args,phase:'create_anyway'}).success).toBe(false);
 expect(DomainCommandArgumentsSchema.safeParse({...args,episode_key:'new'}).success).toBe(false);
});

it('defines intake collection and read-only status as finite Flow commands',()=>{
 expect(DomainCommandConfigSchema.safeParse({...shared,command:'service_desk_intake',configurationId:7,
  configurationRevision:2,phase:'qualified',input:{...input,identifier:'{{intake.identifier}}'}}).success).toBe(true);
 expect(DomainCommandConfigSchema.safeParse({...shared,command:'service_desk_status'}).success).toBe(true);
 expect(DomainCommandConfigSchema.safeParse({...shared,command:'service_desk_status',ownerId:7}).success).toBe(false);
 expect(DomainCommandConfigSchema.safeParse({...shared,command:'create_lead'}).success).toBe(true);
 expect(DomainCommandConfigSchema.safeParse({...shared,command:'create_task'}).success).toBe(false);
});

it('distinguishes recorded test demand from a confirmed remote ticket without disclosing personal input',()=>{
 const result={command:'service_desk_intake',resource_type:'JrcServiceDesk::IntakeDemand',resource_id:9,created:true,
  delivery:'NOT_APPLICABLE',event:{id:episode,causation_id:episode,type:'service_desk.intake.recorded'},
  intake:{id:'9',episode_key:episode,configuration_id:'7',state:'test_only',created:true,remote_id:null,error_code:null,stages:{}}};
 expect(DomainCommandResultSchema.safeParse(result).success).toBe(true);
 expect(DomainCommandResultSchema.safeParse({...result,intake:{...result.intake,identifier:input.identifier}}).success).toBe(false);
 expect(DomainCommandResultSchema.safeParse({...result,intake:{...result.intake,state:'confirmed',remote_id:null}}).success).toBe(false);
});
