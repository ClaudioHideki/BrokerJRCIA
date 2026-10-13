import {expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
const state=vi.hoisted(()=>({account:undefined as any}));
vi.mock('../../src/modules/automations/service.js',async original=>({...await original() as object,requireAutomationDraftAccess:vi.fn(async()=>{})}));
vi.mock('../../src/modules/attendance/transition.js',async original=>({...await original() as object,lockOwnershipMutations:vi.fn(async()=>{})}));
vi.mock('../../src/modules/attendance/repository.js',async original=>({...await original() as object,lockAttendanceChannel:vi.fn(async()=>{})}));
vi.mock('../../src/modules/integrations/chatwoot-context.js',async original=>({...await original() as object,readChatwootAccount:vi.fn(async()=>state.account)}));
import {createFlowDelegationService} from '../../src/modules/flows/delegation/service.js';

export function serviceFixture(){
 const org=randomUUID(),actor=randomUUID(),credentialId=randomUUID(),integration=randomUUID(),channel=randomUUID(),token='c'.repeat(43),nonce=randomUUID();
 const expires=new Date(Date.now()+287123),credential={id:credentialId,revision:2,scopes:['flow:read'],expires_at:expires,destination_origin:'https://native.example.test',account_id:'7',destination_revision:3,created_by:actor,issuer_auth_version:5};
 state.account={organization_id:org,base_url:credential.destination_origin,account_id:7,status:'READY',encrypted_token:'synthetic',credential_version:4,destination:{revision:3,approvalStatus:'APPROVED'}};
 const mapping={integration_id:integration,channel_id:channel,inbox_id:'9',account_id:'7',destination_revision:3,scopes:['flow:read'],transport:'CENTRAL_TRANSPORT',provider:null};
 let session:any,memberRole='ADMIN',credentialLive=true,sessionLive=true,introspectionMember=true;
 let contextMappings=[mapping];
 const query=vi.fn(async(sql:string,values:any[]=[])=>{
  const result=(rows:any[]=[],rowCount=rows.length)=>({rows,rowCount});
  if(sql.includes('SELECT role FROM lock_local_attendance_member'))return result([{role:memberRole}]);
  if(sql.includes('current_tenant_authentication_valid'))return result([{valid:true}]);
  if(sql.startsWith('SELECT a.organization_id'))return result([{organization_id:org}]);
  if(sql.startsWith('SELECT * FROM flow_delegation_credentials'))return result([credential]);
  if(sql.startsWith('INSERT INTO flow_delegation_credentials'))return result([{id:credentialId,expires_at:expires}]);
  if(sql.startsWith('UPDATE flow_delegation_credentials'))return result([{id:credentialId}],1);
  if(sql.startsWith('SELECT revoked_at IS NULL'))return result([{live:sql.includes('credentials')?credentialLive:sessionLive}]);
  if(sql.startsWith('SELECT c.id FROM chatwoot_connections'))return result(contextMappings.filter(r=>!values[1]||r.integration_id>values[1]).sort((a,b)=>a.integration_id.localeCompare(b.integration_id)).slice(0,values[2]).map(r=>({id:r.integration_id})));
  if(sql.startsWith('SELECT id,channel_id FROM chatwoot_connections'))return result(contextMappings.filter(r=>values[1].includes(r.integration_id)).map(r=>({id:r.integration_id,channel_id:r.channel_id})));
  if(sql.startsWith('SELECT c.id AS integration_id'))return result(contextMappings.filter(r=>values[1].includes(r.integration_id)));
  if(sql.includes('INSERT INTO flow_delegation_sessions(')){
   session={id:values[1],organization_id:org,nonce:values[3],external_actor_id:values[4],credential_id:values[5],credential_revision:values[6],destination_origin:values[7],account_id:String(values[8]),destination_revision:values[9],account_credential_version:values[10],actor_kind:'JRC_NATIVE',user_id:null,auth_version:null};
   return result(sql.includes('RETURNING expires_at')?[{expires_at:expires}]:[]);
  }
  if(sql.startsWith('INSERT INTO flow_delegation_session_grants'))return result([],1);
  if(sql.includes('FROM flow_delegation_sessions WHERE'))return result(session?[session]:[]);
  if(sql.startsWith('SELECT extract(epoch'))return result([{now:String(Date.now())}]);
  if(sql.startsWith('SELECT * FROM flow_delegation_session_grants'))return result([mapping]);
  if(sql.startsWith('SELECT * FROM lock_current_flow_origin_capability'))return result([{kind:'JRC_NATIVE',revision:1}]);
  if(sql.startsWith('SELECT * FROM flow_executor_profiles'))return result([{...mapping,destination_origin:credential.destination_origin,account_credential_version:4,origin_capability_revision:1}]);
  if(sql.startsWith('UPDATE flow_delegation_sessions SET revoked_at'))return result([{id:session.id}],1);
  if(sql.startsWith('INSERT INTO audit_logs'))return result([],1);
  throw new Error('Unhandled controlled transaction query: '+sql);
 });
 const adapter={introspect:vi.fn(async(request:any)=>({...request,member:introspectionMember,accountActive:true,featureEnabled:true,role:'agent'})),fenceAndDrain:vi.fn(),observeFence:vi.fn()};
 const service=createFlowDelegationService({transact:async(o,work)=>{expect(o).toBe(org);return work({query} as never);},nativeAdapter:adapter});
 return {service,query,adapter,org,actor,token,nonce,credential,expires,mapping,setMappings:(rows:typeof contextMappings)=>{contextMappings=rows;},input:{externalActorId:'21',nonce,integrationIds:[integration],scopes:['flow:read']},
  access:{organizationId:org,token},getSession:()=>session,setSession:(s:any)=>{session=s;},setIssuerRole:(role:string)=>{memberRole=role;},revokeCredential:()=>{credentialLive=false;},revokeHostMembership:()=>{introspectionMember=false;}};
}
