import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { attendanceDatabase,seedAttendanceTenant } from './helpers/attendance.js';
import { createChatwootService } from '../../src/modules/integrations/chatwoot-service.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
const key=Buffer.alloc(32,6).toString('base64');
beforeAll(async()=>{db=await attendanceDatabase();},60000);
afterAll(async()=>{await db?.dispose();});
async function harness() {
  const tenant=await seedAttendanceTenant(db.database),other=await seedAttendanceTenant(db.database);
  const token=createIntegrationSecrets(key).encrypt(`${tenant.org}:chatwoot-account`,'synthetic-catalog-token');
  await db.database.pool.query('UPDATE chatwoot_accounts SET encrypted_token=$2 WHERE organization_id=$1',[tenant.org,token]);
  const payloads:Record<string,unknown>={
    '/api/v1/profile':{accounts:[{id:7,role:'administrator'}]},
    '/api/v1/accounts/7/inboxes/9':{id:9,name:'Caixa sintética',channel_type:'Channel::Api',greeting_enabled:false,enable_auto_assignment:false,working_hours_enabled:false,timezone:'America/Sao_Paulo',working_hours:[]},
    '/api/v1/accounts/7/agents':[{id:12,name:'Agente da caixa',email:'agent@example.test'},{id:13,name:'Agente externo à caixa',email:'other@example.test'}],
    '/api/v1/accounts/7/inbox_members/9':{payload:[{id:12,name:'Agente da caixa',email:'agent@example.test'}]},
    '/api/v1/accounts/7/teams':[{id:4,name:'Suporte',account_id:7,allow_auto_assign:true}],
    '/api/v1/accounts/7/teams/4/team_members':[{id:12,name:'Agente da caixa'}],
    '/api/v1/accounts/7/labels':{payload:[{id:2,title:'suporte'}]},
    '/api/v1/accounts/7/custom_attribute_definitions':[{id:3,attribute_key:'setor',attribute_display_name:'Setor',attribute_display_type:'text',attribute_model:'conversation_attribute',attribute_values:[]}],
    '/api/v1/accounts/7/inboxes/9/agent_bot':{agent_bot:null},
  };
  const fetch=vi.fn(async(url:URL|string|Request)=>{const path=new URL(String(url)).pathname;if(!(path in payloads))return new Response('',{status:404});return new Response(JSON.stringify(payloads[path]));});
  const service=createChatwootService({baseUrl:`https://${tenant.org}.example.test`,publicOrigin:'https://broker.example.test',encryptionKey:key,externalDestinationsEnabled:true,transact:db.transact,resolveIntegration:async()=>undefined,fetch});
  return {tenant,other,fetch,payloads,service};
}
it('resolves the real company/account/inbox and returns a sanitized observed catalog',async()=>{
  const h=await harness(),catalog=await h.service.attendanceCatalog(h.tenant.org,h.tenant.integration);
  expect(catalog.scope).toEqual(h.tenant.scope);
  expect(catalog.agents).toEqual([{id:12,name:'Agente da caixa',inboxMember:true},{id:13,name:'Agente externo à caixa',inboxMember:false}]);
  expect(catalog.teams).toEqual([{id:4,name:'Suporte',autoAssignment:true}]);
  expect(catalog.capabilities).toMatchObject({teams:'SUPPORTED',labels:'SUPPORTED',hours:'SUPPORTED',controlEvents:'UNVERIFIED',initialPending:'UNVERIFIED'});
  expect(JSON.stringify(catalog)).not.toMatch(/synthetic-catalog-token|encrypted_token|email|agent@example/);
  expect(h.fetch.mock.calls.every(call=>new URL(String(call[0])).origin===`https://${h.tenant.org}.example.test`)).toBe(true);
});
it('rejects another tenant integration before sending any remote request',async()=>{
  const h=await harness();
  await expect(h.service.attendanceCatalog(h.tenant.org,h.other.integration)).rejects.toMatchObject({code:'INTEGRATION_NOT_FOUND'});
  expect(h.fetch).not.toHaveBeenCalled();
});
it('rejects destination or credential changes while the remote catalog is being read',async()=>{
  for(const change of ['credential','destination']){
    const h=await harness();let altered=false;const original=h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async url=>{if(!altered){altered=true;await db.database.pool.query(change==='credential'?'UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1':'UPDATE chatwoot_destinations SET revision=revision+1 WHERE organization_id=$1',[h.tenant.org]);}return original(url);});
    await expect(h.service.attendanceCatalog(h.tenant.org,h.tenant.integration)).rejects.toMatchObject({code:'CHATWOOT_CONTEXT_CHANGED'});
  }
});
it('fails closed on revoked credentials and does not return a partial stale catalog',async()=>{
  const h=await harness();h.fetch.mockImplementation(async()=>new Response('',{status:401}));
  await expect(h.service.attendanceCatalog(h.tenant.org,h.tenant.integration)).rejects.toMatchObject({code:'CHATWOOT_REQUEST_REJECTED',httpStatus:401});
});
it('marks unsupported optional metadata explicitly and never asserts pending or control-event support',async()=>{
  const h=await harness();delete h.payloads['/api/v1/accounts/7/labels'];delete h.payloads['/api/v1/accounts/7/inboxes/9/agent_bot'];
  const catalog=await h.service.attendanceCatalog(h.tenant.org,h.tenant.integration);
  expect(catalog.labels).toEqual([]);expect(catalog.remoteBot).toBeNull();
  expect(catalog.capabilities).toMatchObject({labels:'UNSUPPORTED',agentBot:'UNSUPPORTED',controlEvents:'UNVERIFIED',initialPending:'UNVERIFIED'});
});
it('rejects a remotely changed inbox identity',async()=>{
  const h=await harness();h.payloads['/api/v1/accounts/7/inboxes/9']={id:10,name:'Wrong',channel_type:'Channel::Api'};
  await expect(h.service.attendanceCatalog(h.tenant.org,h.tenant.integration)).rejects.toMatchObject({code:'CHATWOOT_BINDING_MISMATCH'});
});
it('does not mark an incomplete or unknown-timezone working schedule as supported',async()=>{
  const h=await harness();
  h.payloads['/api/v1/accounts/7/inboxes/9']={id:9,name:'Caixa',channel_type:'Channel::Api',working_hours_enabled:true,timezone:'America/Sao_Paulo',working_hours:[]};
  expect((await h.service.attendanceCatalog(h.tenant.org,h.tenant.integration)).capabilities.hours).toBe('UNVERIFIED');
  h.payloads['/api/v1/accounts/7/inboxes/9']={id:9,name:'Caixa',channel_type:'Channel::Api',working_hours_enabled:false,timezone:'Invalid/Zone',working_hours:[]};
  expect((await h.service.attendanceCatalog(h.tenant.org,h.tenant.integration)).capabilities.hours).toBe('UNVERIFIED');
});
it('revalidates a human destination and rejects deleted teams or agents outside the inbox',async()=>{
  const h=await harness();
  await expect(h.service.validateHumanDestination(h.tenant.scope,{teamId:4,agentId:12})).resolves.toMatchObject({target:{teamId:4,agentId:12}});
  await expect(h.service.validateHumanDestination(h.tenant.scope,{teamId:null,agentId:13})).rejects.toMatchObject({code:'ATTENDANCE_AGENT_NOT_IN_INBOX'});
  h.payloads['/api/v1/accounts/7/teams']=[];
  await expect(h.service.validateHumanDestination(h.tenant.scope,{teamId:4,agentId:null})).rejects.toMatchObject({code:'ATTENDANCE_TEAM_NOT_FOUND'});
});
it('rejects a forged scope, empty human destination and mismatching team membership',async()=>{
  const h=await harness();
  await expect(h.service.validateHumanDestination({...h.tenant.scope,accountId:8},{teamId:4,agentId:null})).rejects.toMatchObject({code:'CHATWOOT_CONTEXT_CHANGED'});
  await expect(h.service.validateHumanDestination(h.tenant.scope,{teamId:null,agentId:null})).rejects.toMatchObject({code:'ATTENDANCE_HUMAN_TARGET_REQUIRED'});
  h.payloads['/api/v1/accounts/7/teams/4/team_members']=[];
  await expect(h.service.validateHumanDestination(h.tenant.scope,{teamId:4,agentId:12})).rejects.toMatchObject({code:'ATTENDANCE_AGENT_NOT_IN_TEAM'});
});
