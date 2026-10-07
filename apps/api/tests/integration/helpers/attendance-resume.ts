import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './attendance.js';
import { ChatwootClient } from '../../../src/modules/integrations/chatwoot-client.js';
import { initializeChatwootAttendanceMap, recordChatwootAttendanceEvent } from '../../../src/modules/integrations/chatwoot-attendance-store.js';
import { createAttendanceResumeService } from '../../../src/modules/attendance/resume-service.js';
import { readChatwootAttendanceGate } from '../../../src/modules/attendance/control-service.js';

export async function resumeFixture(db:Awaited<ReturnType<typeof attendanceDatabase>>,remote=true,central=false) {
  const t=await seedAttendanceTenant(db.database,remote);
  const actor=(await db.database.pool.query('select user_id from memberships where organization_id=$1',[t.org])).rows[0].user_id;
  await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)',[t.org]);
  await db.database.pool.query("update automation_definitions set lifecycle_status='PUBLISHED',active_version=1 where organization_id=$1",[t.org]);
  await db.database.pool.query("update messaging_channels set bot_public_id=$2,bot_origin_reference='jrc-automation-v2' where id=$1",[t.channel,t.automation]);
  await db.database.pool.query('insert into automation_bindings(organization_id,automation_id,version,channel_id) values($1,$2,1,$3)',[t.org,t.automation,t.channel]);
  await db.database.pool.query("insert into attendance_owners(organization_id,channel_id,integration_id,revision,executor,automation_id,version) values($1,$2,$3,1,'BROKER',$4,1)",[t.org,t.channel,remote?t.integration:null,t.automation]);
  if(central){
    await db.database.pool.query("UPDATE messaging_channels SET transport='CENTRAL_TRANSPORT',provider=NULL,provider_account_id=NULL,phone_number_id=NULL,waba_id=NULL,credential_reference=NULL WHERE id=$1",[t.channel]);
    await db.database.pool.query("UPDATE chatwoot_accounts SET encrypted_token='synthetic' WHERE organization_id=$1",[t.org]);
    await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='APPROVED' WHERE organization_id=$1",[t.org]);
    await db.database.pool.query("INSERT INTO central_transport_bindings(organization_id,channel_id,integration_id,origin,account_id,inbox_id,destination_revision,credential_version,owner_revision,bot_id,bot_callback) VALUES($1,$2,$3,$4,7,9,1,1,1,19,'https://broker.example.test/events')",[t.org,t.channel,t.integration,`https://${t.org}.example.test`]);
  }
  let canonical={id:51,account_id:7,inbox_id:9,status:'open',updated_at:100,meta:{sender:{id:41},assignee:{id:12,type:'user'} as null|{id:number;type:string},assignee_type:'User' as null|'User'|'AgentBot',team:{id:4} as null|{id:number}}};
  const scope={...t.scope,credentialRevision:1};
  const record=()=>db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,scope,{...canonical,event:'conversation_updated',account:{id:7}}));
  const human=()=>db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,scope,{event:'message_created',id:99,account:{id:7},inbox:{id:9},conversation:{id:51,inbox_id:9},message_type:'outgoing',private:true,sender:{id:12,type:'user'}}));
  if(remote){
    await db.database.pool.query("insert into chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) values($1,$2,$3,41,'synthetic',51)",[t.org,t.integration,t.conversation]);
    await db.transact(t.org,tx=>initializeChatwootAttendanceMap(tx,scope,{conversationId:t.conversation,remoteConversationId:51,canonical}));
  }else await db.database.pool.query("update messaging_conversations set mode='HUMAN' where id=$1",[t.conversation]);
  const writes:Record<string,unknown>[]=[];
  let callbacks=true;
  let afterWrite:(()=>Promise<void>)|null=null,timeout=false,autoAssignment=false,botId=19;
  const fetch=vi.fn(async(input:URL|string|Request,init?:RequestInit)=>{
    const path=new URL(String(input)).pathname,body=typeof init?.body==='string'?JSON.parse(init.body):{};
    if(init?.method==='POST'){
      writes.push(body);
      if(path.endsWith('/assignments')){
        if(Object.hasOwn(body,'assignee_id')){canonical.meta.assignee=null;canonical.meta.assignee_type=null;}
        else if(Object.hasOwn(body,'team_id'))canonical.meta.team=null;
      }else if(path.endsWith('/toggle_status'))canonical.status=body.status;
      canonical.updated_at++;if(callbacks)await record();if(afterWrite)await afterWrite();if(timeout)throw new Error('timeout after write');
    }
    const result=path.endsWith('/inboxes/9')?{id:9,name:'Synthetic',channel_type:central?'Channel::Whatsapp':'Channel::Api',greeting_enabled:false,enable_auto_assignment:autoAssignment}
      :path.endsWith('/agent_bot')?{agent_bot:central?{id:botId,name:'Broker',outgoing_url:'https://broker.example.test/events',secret:'synthetic'}:null}:canonical;
    return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
  });
  const client=()=>new ChatwootClient({baseUrl:`https://${t.org}.example.test`,token:'synthetic-token',fetch});
  const service=createAttendanceResumeService({transact:db.transact});
  const gate=await db.transact(t.org,tx=>readChatwootAttendanceGate(tx,{organizationId:t.org,channelId:t.channel,conversationId:t.conversation}));
  const reserve=()=>service.requestAttendanceResume(t.org,actor,randomUUID(),{conversationId:t.conversation,expectedControlRevision:gate.revision,expectedOwnerRevision:1,target:{kind:'NEW_SESSION'}});
  return {...t,actor,client,service,reserve,writes,human,record,scope,canonical,
    setBot:(id:number)=>{botId=id;},setCallbacks:(v:boolean)=>{callbacks=v;},setAfterWrite:(f:typeof afterWrite)=>{afterWrite=f;},setTimeout:(v:boolean)=>{timeout=v;},setAutoAssignment:(v:boolean)=>{autoAssignment=v;}};
}
