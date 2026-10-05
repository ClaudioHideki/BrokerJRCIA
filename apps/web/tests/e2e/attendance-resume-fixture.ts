import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withOrganizationTransaction } from '../../../api/src/db/tenant-transaction.js';
import { createAttendanceResumeService } from '../../../api/src/modules/attendance/resume-service.js';
import { createAttendanceResumeWorker } from '../../../api/src/modules/attendance/resume-worker.js';
import { createExecutionService } from '../../../api/src/modules/automations/service.js';
import { ChatwootClient } from '../../../api/src/modules/integrations/chatwoot-client.js';
import { initializeChatwootAttendanceMap,recordChatwootAttendanceEvent } from '../../../api/src/modules/integrations/chatwoot-attendance-store.js';

/** Real tenant transactions, routes and workers; synthetic central only. Never contacts WhatsApp. */
export async function createAttendanceResumeFixture(admin:Pool,pool:Pool,email:string){
  const actor=(await admin.query("select m.user_id from memberships m join organizations o on o.id=m.organization_id join users u on u.id=m.user_id where o.name='JRC E2E Matriz' and u.email=$1",[email])).rows[0].user_id;
  const org=randomUUID();
  const identity=await admin.connect();
  try{
    await identity.query('BEGIN');
    await identity.query("insert into organizations(id,name,slug) values($1,'JRC E2E Retomada',$2)",[org,`resume-${org}`]);
    await identity.query("insert into memberships(organization_id,user_id,role) values($1,$2,'OWNER')",[org,actor]);
    await identity.query('COMMIT');
  }catch(error){await identity.query('ROLLBACK');throw error;}finally{identity.release();}
  const channel=randomUUID(),conversation=randomUUID(),automation=randomUUID(),integration=randomUUID();
  const transact=<T>(id:string,work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(pool,id,work);
  const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
  const graph={nodes:[node('start','start'),node('menu','menu',{text:'Escolha',options:[{value:'1',label:'Encerrar'}]}),node('end','end')],
    edges:[{id:'start',source:'start',target:'menu',port:'next'},{id:'end',source:'menu',target:'end',port:'option-1'}]};
  await admin.query('insert into flow_features(organization_id,enabled) values($1,true) on conflict(organization_id) do update set enabled=true',[org]);
  const account=(await admin.query("insert into provider_accounts(organization_id,provider,name) values($1,'META','Resume E2E') returning id",[org])).rows[0].id;
  await admin.query("insert into messaging_channels(id,organization_id,provider_account_id,phone_number_id,waba_id,credential_reference,bot_public_id,bot_origin_reference) values($1,$2,$3,'resume-e2e','resume-e2e','e2e-meta',$4,'jrc-automation-v2')",[channel,org,account,automation]);
  const contact=(await admin.query("insert into messaging_contacts(organization_id,external_id) values($1,'resume-synthetic-contact') returning id",[org])).rows[0].id;
  await admin.query('insert into messaging_conversations(id,organization_id,channel_id,contact_id) values($1,$2,$3,$4)',[conversation,org,channel,contact]);
  await admin.query("insert into automation_definitions(id,organization_id,name,draft_graph) values($1,$2,'Retomada E2E',$3)",[automation,org,JSON.stringify(graph)]);
  await admin.query('insert into automation_versions(organization_id,automation_id,version,graph,checksum) values($1,$2,1,$3,$4)',[org,automation,JSON.stringify(graph),'a'.repeat(64)]);
  await admin.query("update automation_definitions set lifecycle_status='PUBLISHED',active_version=1 where organization_id=$1",[org]);
  await admin.query('insert into automation_bindings(organization_id,automation_id,version,channel_id) values($1,$2,1,$3)',[org,automation,channel]);
  await admin.query("insert into chatwoot_accounts(organization_id,base_url,account_id,status) values($1,'https://resume.example.test',7,'READY')",[org]);
  await admin.query("insert into chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) values($1,$2,$3,9,'Resume E2E','READY')",[integration,org,channel]);
  await admin.query("insert into attendance_owners(organization_id,channel_id,integration_id,revision,executor,automation_id,version) values($1,$2,$3,1,'BROKER',$4,1)",[org,channel,integration,automation]);
  await admin.query("insert into chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) values($1,$2,$3,41,'synthetic',51)",[org,integration,conversation]);
  const scope={organizationId:org,channelId:channel,integrationId:integration,destinationRevision:1,credentialRevision:1,accountId:7,inboxId:9};
  const canonical={id:51,account_id:7,inbox_id:9,status:'open',updated_at:100,meta:{sender:{id:41},assignee:{id:12,type:'user'} as null|{id:number;type:string},assignee_type:'User' as string|null,team:{id:4} as null|{id:number}}};
  await transact(org,tx=>initializeChatwootAttendanceMap(tx,scope,{conversationId:conversation,remoteConversationId:51,canonical}));
  const fetch=async(input:URL|string|Request,init?:RequestInit)=>{
    const path=new URL(String(input)).pathname;
    if(init?.method==='POST'){
      const body=JSON.parse(String(init.body));
      if(path.endsWith('/assignments')){if(Object.hasOwn(body,'assignee_id')){canonical.meta.assignee=null;canonical.meta.assignee_type=null;}else canonical.meta.team=null;}
      else if(path.endsWith('/toggle_status'))canonical.status=body.status;
      else throw new Error('Unexpected synthetic mutation');
      canonical.updated_at++;
      await transact(org,tx=>recordChatwootAttendanceEvent(tx,scope,{...canonical,event:'conversation_updated',account:{id:7}}));
    }
    if(path.endsWith('/inboxes/9'))return Response.json({id:9,name:'Synthetic',channel_type:'Channel::Api',greeting_enabled:false,enable_auto_assignment:false});
    if(path.endsWith('/agent_bot'))return Response.json({agent_bot:null});
    if(path.includes('/conversations/51'))return Response.json(canonical);
    throw new Error('Unexpected synthetic read');
  };
  const service=createAttendanceResumeService({transact}),worker=createAttendanceResumeWorker({transact,client:()=>new ChatwootClient({baseUrl:'https://resume.example.test',token:'synthetic-only',fetch})});
  const executions=createExecutionService({transact});
  let running:Promise<void>|undefined,failure=false;
  const timer=setInterval(()=>{if(running)return;running=(async()=>{await worker.runOnce(org);await executions.runOnce(org);})().catch(()=>{failure=true;}).finally(()=>{running=undefined;});},100);
  process.env.JRC_E2E_RESUME_CHANNEL_ID=channel;
  return {service,async close(){clearInterval(timer);await running;delete process.env.JRC_E2E_RESUME_CHANNEL_ID;if(failure)throw new Error('Resume fixture worker failed');}};
}
