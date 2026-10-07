import { attendanceCatalogSchema,attendanceScopeSchema,humanTargetSchema,type AttendanceCatalog,type AttendanceScope,type HumanTarget } from '@jrc/contracts';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import { resolveAttendanceScope } from '../attendance/repository.js';
import { AttendanceError } from '../attendance/types.js';
import { requireActiveOrganization } from '../tenancy/operational-limits.js';
import { ChatwootClient,ChatwootError } from './chatwoot-client.js';
import { publicChatwootCapabilities } from './chatwoot-compatibility.js';
import { readChatwootAccount,type AccountRow } from './chatwoot-context.js';
import { IntegrationError } from './integration-error.js';
import {classificationScope} from './chatwoot-attendance-store.js';

type Options={transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;client(account:AccountRow):ChatwootClient};
/** The type permits probing; support still requires the actual authenticated catalog endpoints. */
export const supportsAttendanceInbox=(transport:string|undefined,type:string)=>type==='Channel::Api'||transport==='CENTRAL_TRANSPORT'&&type==='Channel::Whatsapp';
const sameScope=(a:AttendanceScope,b:AttendanceScope)=>Object.keys(a).every(key=>a[key as keyof AttendanceScope]===b[key as keyof AttendanceScope]);
function hasUsableHours(inbox:Awaited<ReturnType<ChatwootClient['attendanceInbox']>>) {
  if(inbox.working_hours_enabled===undefined||!inbox.timezone||!inbox.working_hours)return false;
  try{new Intl.DateTimeFormat('en',{timeZone:inbox.timezone}).format();}catch{return false;}
  if(!inbox.working_hours_enabled)return true;
  if(new Set(inbox.working_hours.map(day=>day.day_of_week)).size!==7)return false;
  return inbox.working_hours.every(day=>{
    if(day.closed_all_day)return day.open_all_day!==true;
    if(day.open_all_day)return true;
    if(day.open_hour==null||day.open_minutes==null||day.close_hour==null||day.close_minutes==null)return false;
    return day.open_hour*60+day.open_minutes<day.close_hour*60+day.close_minutes;
  });
}
async function optional<T>(read:()=>Promise<T>):Promise<{state:'SUPPORTED';data:T}|{state:'UNSUPPORTED';data:null}> {
  try{return {state:'SUPPORTED',data:await read()};}
  catch(error){
    // Authentication, timeout and malformed data are failures, never proof of an absent capability.
    if(error instanceof ChatwootError&&[404,405,501].includes(error.httpStatus??0))return {state:'UNSUPPORTED',data:null};
    throw error;
  }
}
export function createChatwootAttendanceService(options:Options) {
  async function snapshot(org:string,id:string) {
    return options.transact(org,async tx=>{
      await requireActiveOrganization(tx,org);
      const connection=(await tx.query<{channel_id:string}>('SELECT channel_id FROM chatwoot_connections WHERE organization_id=$1 AND id=$2 FOR SHARE',[org,id])).rows[0];
      if(!connection)throw new IntegrationError('INTEGRATION_NOT_FOUND',404);
      let scope;
      try{scope=await resolveAttendanceScope(tx,org,connection.channel_id);}
      catch(error){if(error instanceof AttendanceError)throw new IntegrationError(error.code,error.statusCode);throw error;}
      const account=await readChatwootAccount(tx,org);
      if(!scope||scope.integrationId!==id||!account)throw new IntegrationError('CHATWOOT_ACCOUNT_NOT_READY',409);
      const transport=(await tx.query<{transport:string}>('SELECT transport FROM messaging_channels WHERE organization_id=$1 AND id=$2',[org,scope.channelId])).rows[0]?.transport;
      const authority=await classificationScope(tx,{...scope,credentialRevision:account.credential_version});
      return {scope,account,transport,brokerBotId:authority.brokerBotId??null};
    });
  }
  async function catalog(org:string,id:string):Promise<AttendanceCatalog> {
      const initial=await snapshot(org,id),{scope,account}=initial,client=options.client(account);
      await client.verifyAccount(scope.accountId);
      const [inbox,agents,members,teams,labels,attributes,bot]=await Promise.all([
        client.attendanceInbox(scope.accountId,scope.inboxId),client.agents(scope.accountId),client.inboxAgents(scope.accountId,scope.inboxId),
        optional(()=>client.teams(scope.accountId)),optional(()=>client.labels(scope.accountId)),optional(()=>client.attributeDefinitions(scope.accountId)),
        optional(()=>client.inboxFlowBot(scope.accountId,scope.inboxId)),
      ]);
      if(inbox.id!==scope.inboxId||!supportsAttendanceInbox(initial.transport,inbox.channel_type))throw new ChatwootError('CHATWOOT_BINDING_MISMATCH');
      const current=await snapshot(org,id);
      if(!sameScope(current.scope,scope)||current.transport!==initial.transport||current.brokerBotId!==initial.brokerBotId||current.account.credential_version!==account.credential_version||current.account.base_url!==account.base_url)
        throw new IntegrationError('CHATWOOT_CONTEXT_CHANGED',409);
      const assigned=new Set(members.map(member=>member.id));
      const knownAgents=new Set(agents.map(agent=>agent.id));
      if(members.some(member=>!knownAgents.has(member.id)))throw new ChatwootError('CHATWOOT_BINDING_MISMATCH');
      return attendanceCatalogSchema.parse({
        scope,observedAt:new Date().toISOString(),credentialRevision:account.credential_version,
        teams:(teams.data??[]).map(team=>({id:team.id,name:team.name,autoAssignment:team.allow_auto_assign??null})),
        agents:agents.map(agent=>({id:agent.id,name:agent.name,inboxMember:assigned.has(agent.id)})),
        labels:(labels.data??[]).map(label=>({id:label.id,name:label.title})),
        attributes:(attributes.data??[]).map(attribute=>({id:attribute.id,key:attribute.attribute_key,name:attribute.attribute_display_name,displayType:attribute.attribute_display_type,model:attribute.attribute_model,values:attribute.attribute_values??[]})),
        hours:{enabled:inbox.working_hours_enabled??null,timezone:inbox.timezone??null,days:(inbox.working_hours??[]).map(day=>({day:day.day_of_week,closed:day.closed_all_day,allDay:day.open_all_day??false,
          openHour:day.open_hour??null,openMinute:day.open_minutes??null,closeHour:day.close_hour??null,closeMinute:day.close_minutes??null}))},
        remoteBot:bot.data?{id:bot.data.id,name:bot.data.name}:null,
        ...(current.brokerBotId?{brokerBotId:current.brokerBotId}:{}),
        inboxPolicy:{greetingEnabled:inbox.greeting_enabled??null,autoAssignmentEnabled:inbox.enable_auto_assignment??null},
        capabilities:{teams:teams.state,agents:'SUPPORTED',inboxMembership:'SUPPORTED',labels:labels.state,attributes:attributes.state,
          hours:hasUsableHours(inbox)?'SUPPORTED':'UNVERIFIED',agentBot:bot.state,
          signatures:publicChatwootCapabilities(account).signatures,controlEvents:'UNVERIFIED',initialPending:'UNVERIFIED'},
      });
  }
  return {
    catalog,
    async validateTarget(expected:AttendanceScope,value:HumanTarget) {
      const parsedScope=attendanceScopeSchema.safeParse(expected),parsedTarget=humanTargetSchema.safeParse(value);
      if(!parsedScope.success)throw new IntegrationError('ATTENDANCE_SCOPE_INVALID',422);
      if(!parsedTarget.success)throw new IntegrationError('ATTENDANCE_HUMAN_TARGET_REQUIRED',422);
      const scope=parsedScope.data,target=parsedTarget.data;
      const initial=await snapshot(scope.organizationId,scope.integrationId);
      if(!sameScope(initial.scope,scope))throw new IntegrationError('CHATWOOT_CONTEXT_CHANGED',409);
      const observed=await catalog(scope.organizationId,scope.integrationId);
      if(!sameScope(observed.scope,scope)||observed.credentialRevision!==initial.account.credential_version)throw new IntegrationError('CHATWOOT_CONTEXT_CHANGED',409);
      if(target.teamId!==null){
        if(observed.capabilities.teams!=='SUPPORTED')throw new IntegrationError('ATTENDANCE_TEAMS_UNAVAILABLE',409);
        if(!observed.teams.some(team=>team.id===target.teamId))throw new IntegrationError('ATTENDANCE_TEAM_NOT_FOUND',409);
      }
      if(target.agentId!==null&&!observed.agents.some(agent=>agent.id===target.agentId&&agent.inboxMember))throw new IntegrationError('ATTENDANCE_AGENT_NOT_IN_INBOX',409);
      if(target.teamId!==null&&target.agentId!==null){
        const members=await options.client(initial.account).teamAgents(scope.accountId,target.teamId);
        if(!members.some(agent=>agent.id===target.agentId))throw new IntegrationError('ATTENDANCE_AGENT_NOT_IN_TEAM',409);
      }
      const current=await snapshot(scope.organizationId,scope.integrationId);
      if(!sameScope(current.scope,scope)||current.account.credential_version!==initial.account.credential_version)throw new IntegrationError('CHATWOOT_CONTEXT_CHANGED',409);
      return {scope,target,observedAt:new Date().toISOString(),credentialRevision:current.account.credential_version};
    },
  };
}
