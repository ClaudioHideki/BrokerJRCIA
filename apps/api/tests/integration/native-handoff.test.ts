import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HumanTarget } from '@jrc/contracts';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import type { OutboxRow } from '../../src/modules/automations/repository.js';
import { createEventRouter,createExecutionService,createOutboxDispatcher } from '../../src/modules/automations/service.js';
import { createAutomationEffectDispatcher } from '../../src/commands/automation-worker.js';
import { createPostgresHandoffRepository } from '../../src/modules/attendance/handoff-repository.js';
import { createMessagingService } from '../../src/modules/messaging/service.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { createNativeHandoffService } from '../../src/modules/attendance/handoff-service.js';
import { createChatwootAttendanceService } from '../../src/modules/integrations/chatwoot-attendance-service.js';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';
import { initializeChatwootAttendanceMap, recordChatwootAttendanceEvent } from '../../src/modules/integrations/chatwoot-attendance-store.js';
import { probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';

describe('native handoff durable PostgreSQL state',()=>{
  let db:Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async()=>{db=await attendanceDatabase();},60000);
  afterAll(async()=>{await db?.dispose();});
  async function fixture(target:HumanTarget={teamId:4,agentId:null}) {
    const t=await seedAttendanceTenant(db.database),binding=randomUUID(),execution=randomUUID(),outbox=randomUUID(),lease=randomUUID();
    await db.database.pool.query(`INSERT INTO flow_features(organization_id,enabled) VALUES($1,true) ON CONFLICT(organization_id) DO UPDATE SET enabled=true`,[t.org]);
    await db.database.pool.query(`UPDATE messaging_channels SET bot_public_id=$2,bot_origin_reference='jrc-automation-v2' WHERE id=$1`,[t.channel,t.automation]);
    await db.database.pool.query(`INSERT INTO automation_bindings(organization_id,id,automation_id,version,channel_id) VALUES($1,$2,$3,1,$4)`,[t.org,binding,t.automation,t.channel]);
    await db.database.pool.query(`INSERT INTO attendance_owners(organization_id,channel_id,integration_id,executor,revision,automation_id,version)
      VALUES($1,$2,$3,'BROKER',1,$4,1)`,[t.org,t.channel,t.integration,t.automation]);
    await db.database.pool.query(`INSERT INTO automation_executions(organization_id,id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id,status)
      VALUES($1,$2,$3,1,$4,$5,$6,'synthetic',$7,'HANDOFF')`,[t.org,execution,t.automation,binding,t.channel,t.conversation,randomUUID()]);
    const payload={handoffVersion:1,destination:{integrationId:t.integration,destinationRevision:1,credentialRevision:1,accountId:7,inboxId:9},target};
    await db.database.pool.query(`INSERT INTO automation_outbox(organization_id,id,execution_id,node_id,ordinal,kind,payload,status,attempts,lease_token,lease_expires_at)
      VALUES($1,$2,$3,'handoff',1,'HANDOFF',$4,'UNKNOWN',1,$5,now()+interval '3 minutes')`,[t.org,outbox,execution,JSON.stringify(payload),lease]);
    await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
      VALUES($1,$2,$3,41,'synthetic',51)`,[t.org,t.integration,t.conversation]);
    const scope={...t.scope,credentialRevision:1};
    let canonical={id:51,account_id:7,inbox_id:9,status:'pending',updated_at:100,meta:{sender:{id:41},assignee:null as null|{id:number;type:string},assignee_type:null as null|'User'|'AgentBot',team:null as null|{id:number}}};
    await db.transact(t.org,tx=>initializeChatwootAttendanceMap(tx,scope,{conversationId:t.conversation,remoteConversationId:51,canonical}));
    const requests:{path:string;method:string;body:Record<string,unknown>}[]=[];
    let deferredOpening:Record<string,unknown>|null=null,delayOpening:'OPENED'|'ASSIGNMENT_DISPATCHED'|null=null;
    let callback=true,timeout:'open'|'assign'|null=null,beforeOpen:(()=>Promise<void>)|null=null,afterOpen:(()=>Promise<void>)|null=null;
    const record=()=>db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,scope,{...canonical,event:'conversation_updated',account:{id:7}}));
    const human=()=>db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,scope,{event:'message_created',id:91,account:{id:7},inbox:{id:9},conversation:{id:51,inbox_id:9},message_type:'outgoing',private:true,sender:{id:12,type:'user'}}));
    const fetch=vi.fn(async(input:URL|string|Request,init?:RequestInit)=>{
      const path=new URL(String(input)).pathname,method=init?.method??'GET',body=typeof init?.body==='string'?JSON.parse(init.body):{};requests.push({path,method,body});
      expect(new URL(String(input)).origin).toBe(`https://${t.org}.example.test`);
      let response:unknown;
      if(delayOpening==='OPENED'&&deferredOpening&&path.endsWith('/profile')){
        await db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,scope,deferredOpening));deferredOpening=null;
      }
      if(path.endsWith('/profile'))response={accounts:[{id:7,role:'administrator'}]};
      else if(path.endsWith('/inboxes/9'))response={id:9,name:'Synthetic',channel_type:'Channel::Api',greeting_enabled:false,enable_auto_assignment:false};
      else if(path.endsWith('/agents'))response=[{id:12,name:'Synthetic',email:'synthetic@example.test'}];
      else if(path.endsWith('/inbox_members/9'))response={payload:[{id:12,name:'Synthetic',email:'synthetic@example.test'}]};
      else if(path.endsWith('/teams'))response=[{id:4,name:'Support',account_id:7,allow_auto_assign:false}];
      else if(path.endsWith('/labels'))response={payload:[]};
      else if(path.endsWith('/custom_attribute_definitions'))response=[];
      else if(path.endsWith('/agent_bot'))response={agent_bot:null};
      else if(path.endsWith('/conversations/51'))response=canonical;
      else if(path.endsWith('/toggle_status')){
        if(beforeOpen)await beforeOpen();canonical.status='open';canonical.updated_at++;
        if(callback){if(delayOpening)deferredOpening={...structuredClone(canonical),event:'conversation_updated',account:{id:7}};else await record();}if(afterOpen)await afterOpen();if(timeout==='open')throw new Error('Synthetic timeout');response={};
      }else if(path.endsWith('/assignments')){
        if(delayOpening==='ASSIGNMENT_DISPATCHED'&&deferredOpening){await db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,scope,deferredOpening));deferredOpening=null;}
        if(body.team_id){canonical.meta.team={id:Number(body.team_id)};expect(body).not.toHaveProperty('assignee_id');}
        else {canonical.meta.assignee={id:Number(body.assignee_id),type:'user'};canonical.meta.assignee_type='User';}
        canonical.updated_at++;if(callback)await record();if(timeout==='assign')throw new Error('Synthetic timeout');response={};
      }else throw new Error('Unexpected synthetic request '+path);
      return Response.json(response);
    });
    const client=()=>new ChatwootClient({baseUrl:`https://${t.org}.example.test`,token:'synthetic-only',fetch});
    const attendanceService=createChatwootAttendanceService({transact:db.transact,client});
    const service=()=>createNativeHandoffService({transact:db.transact,client,attendanceService});
    const item:OutboxRow={id:outbox,organizationId:t.org,executionId:execution,channelId:t.channel,conversationId:t.conversation,nodeId:'handoff',ordinal:1,kind:'HANDOFF',payload,attempts:1,leaseToken:lease};
    const state=async()=>({operation:(await db.database.pool.query('SELECT * FROM attendance_handoff_operations WHERE organization_id=$1',[t.org])).rows[0],
      outbox:(await db.database.pool.query('SELECT * FROM automation_outbox WHERE id=$1',[outbox])).rows[0],
      session:(await db.database.pool.query('SELECT * FROM attendance_sessions WHERE organization_id=$1',[t.org])).rows[0],
      conversation:(await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0]});
    const expire=async()=>{await db.database.pool.query("UPDATE automation_outbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[outbox]);await db.database.pool.query("UPDATE attendance_handoff_operations SET next_check_at=now()-interval '1 second' WHERE organization_id=$1",[t.org]);};
    return {...t,binding,execution,outbox,item,fetch,service,requests,state,human,expire,canonical,record,
      setCallback:(value:boolean)=>{callback=value;},delayOpening:(value:typeof delayOpening)=>{delayOpening=value;},setTimeout:(value:typeof timeout)=>{timeout=value;},beforeOpen:(fn:()=>Promise<void>)=>{beforeOpen=fn;},afterOpen:(fn:()=>Promise<void>)=>{afterOpen=fn;}};
  }
  it('runs a persisted menu journey through the real engine and worker into canonical team handoff with a synthetic transport receipt',async()=>{
    const t=await fixture(),node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
    const graph={nodes:[node('start','start'),node('menu','menu',{text:'Escolha',variable:'choice',options:[{value:'1',label:'Suporte'},{value:'2',label:'Encerrar'}]}),node('handoff','handoff',t.item.payload),node('end','end')],
      edges:[{id:'start',source:'start',target:'menu',port:'next'},{id:'support',source:'menu',target:'handoff',port:'option-1'},{id:'end',source:'menu',target:'end',port:'option-2'}]};
    await db.database.pool.query('DELETE FROM automation_outbox WHERE organization_id=$1',[t.org]);
    await db.database.pool.query('DELETE FROM automation_executions WHERE organization_id=$1',[t.org]);
    await db.database.pool.query('UPDATE automation_versions SET graph=$2,runtime_state_version=2 WHERE organization_id=$1',[t.org,JSON.stringify(graph)]);
    await db.database.pool.query("UPDATE automation_definitions SET lifecycle_status='PUBLISHED',active_version=1,draft_graph=$2 WHERE organization_id=$1",[t.org,JSON.stringify(graph)]);
    const router=createEventRouter({transact:db.transact,enabled:true}),worker=()=>createExecutionService({transact:db.transact,enabled:true});
    const dispatcher=createOutboxDispatcher({transact:db.transact,enabled:true},createAutomationEffectDispatcher({transact:db.transact,messaging:createPostgresMessagingRepository(),handoff:t.service()}));
    const input={channelId:t.channel,conversationId:t.conversation,eventKey:'synthetic-menu-start',text:'Oi'};
    const started=await router.route(t.org,input);expect(started.execution?.id).toBeTruthy();
    expect(await worker().runOnce(t.org)).toMatchObject({status:'WAITING'});
    expect(await dispatcher.runOnce(t.org)).toMatchObject({status:'SENT'});
    const text=(await db.database.pool.query("SELECT id,content,state FROM messaging_messages WHERE organization_id=$1 AND source='AUTOMATION'",[t.org])).rows[0];
    expect(text).toMatchObject({content:{type:'TEXT',text:'Escolha\n1 - Suporte\n2 - Encerrar'},state:'ACCEPTED'});
    expect(await router.route(t.org,{...input,eventKey:'synthetic-menu-choice',text:'1'})).toMatchObject({resumed:true});
    expect(await worker().runOnce(t.org)).toMatchObject({status:'HANDOFF'});
    expect(await dispatcher.runOnce(t.org)).toMatchObject({status:'NOT_SENT'});expect(t.requests.filter(r=>r.method==='POST')).toHaveLength(0);
    // The provider is synthetic here. Its persisted successful transport receipt
    // is deliberately separate from the earlier automation enqueue acknowledgment.
    await db.database.pool.query("UPDATE messaging_messages SET state='SENT' WHERE id=$1",[text.id]);
    await db.database.pool.query('DELETE FROM messaging_outbox WHERE message_id=$1',[text.id]);
    await db.database.pool.query("UPDATE automation_outbox SET available_at=now() WHERE organization_id=$1 AND kind='HANDOFF'",[t.org]);
    expect(await dispatcher.runOnce(t.org)).toMatchObject({status:'SENT'});
    const handoff=(await db.database.pool.query("SELECT status,payload,remote_reference FROM automation_outbox WHERE organization_id=$1 AND kind='HANDOFF'",[t.org])).rows[0];
    expect(handoff).toMatchObject({status:'SENT',payload:t.item.payload});expect(handoff.remote_reference).toMatch(/^chatwoot-handoff:/);
    expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0].mode).toBe('HUMAN');
    expect(await router.route(t.org,{...input,eventKey:'synthetic-after-handoff',text:'Oi novamente'})).toMatchObject({execution:null});
    expect(await worker().runOnce(t.org)).toEqual({processed:false});expect(await dispatcher.runOnce(t.org)).toEqual({processed:false});
    expect(t.requests.filter(r=>r.method==='POST').map(r=>r.path.split('/').at(-1))).toEqual(['toggle_status','assignments']);
  });
  it.each([{teamId:4,agentId:null},{teamId:null,agentId:12}])('confirms $teamId/$agentId with real callback transitions and keeps bot paused',async target=>{
    const t=await fixture(target);expect(await t.service().dispatch(t.item)).toMatchObject({kind:'SENT'});
    const state=await t.state();expect(state.operation).toMatchObject({state:'APPLIED',phase:'CONFIRMED'});expect(state.outbox.status).toBe('SENT');
    expect(state.conversation.mode).toBe('HUMAN');expect(state.session.state).toBe(target.agentId?'HUMAN_ACTIVE':'WAITING_HUMAN');
    expect(t.requests.filter(r=>r.method==='POST').map(r=>r.path.split('/').at(-1))).toEqual(['toggle_status','assignments']);
    expect(await t.service().dispatch(t.item)).toMatchObject({kind:'SENT'});expect(t.requests.filter(r=>r.method==='POST')).toHaveLength(2);
  });
  it.each(['OPENED','ASSIGNMENT_DISPATCHED'] as const)('accepts delayed unassigned opening callback during %s without losing human protections',async phase=>{
    const t=await fixture();t.delayOpening(phase);expect(await t.service().dispatch(t.item)).toMatchObject({kind:'SENT'});
    expect((await t.state()).operation.state).toBe('APPLIED');expect(t.requests.filter(r=>r.method==='POST')).toHaveLength(2);
  });
  it('pins an existing unassigned attendance session to the actual execution/version without changing its identity',async()=>{
    const t=await fixture(),session=randomUUID();
    await db.database.pool.query(`INSERT INTO attendance_sessions(organization_id,id,channel_id,conversation_id,integration_id,destination_revision,account_id,inbox_id,cycle,state,owner_revision)
      VALUES($1,$2,$3,$4,$5,1,7,9,1,'BOT_ACTIVE',1)`,[t.org,session,t.channel,t.conversation,t.integration]);
    expect(await t.service().dispatch(t.item)).toMatchObject({kind:'SENT'});
    expect((await t.state()).session).toMatchObject({id:session,execution_id:t.execution,automation_id:t.automation,version:1,state:'WAITING_HUMAN'});
  });
  it.each(['credential','destination','inbox'] as const)('pauses stale pinned %s config before any remote call',async changed=>{
    const t=await fixture(),payload=structuredClone(t.item.payload) as {destination:Record<string,unknown>};
    payload.destination[changed==='credential'?'credentialRevision':changed==='destination'?'destinationRevision':'inboxId']=99;
    await db.database.pool.query('UPDATE automation_outbox SET payload=$2 WHERE id=$1',[t.outbox,JSON.stringify(payload)]);
    expect(await t.service().dispatch(t.item)).toEqual({kind:'FAILED',error:'HANDOFF_CONTEXT_CHANGED'});
    const state=await t.state();expect(state.operation.state).toBe('ACTION_REQUIRED');expect(state.outbox.status).toBe('FAILED');expect(state.conversation.mode).toBe('HUMAN');expect(t.fetch).not.toHaveBeenCalled();
  });
  it('waits for actual text transport rather than treating automation enqueue as delivery',async()=>{
    const t=await fixture(),message=randomUUID(),predecessor=randomUUID();
    await db.database.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
      VALUES($1,$2,$3,$4,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Synthetic"}','ACCEPTED',$5,$6)`,[message,t.org,t.channel,t.conversation,`automation:${predecessor}`,'b'.repeat(64)]);
    await db.database.pool.query(`INSERT INTO automation_outbox(organization_id,id,execution_id,node_id,ordinal,kind,status,remote_reference)
      VALUES($1,$2,$3,'text',0,'SEND_TEXT','SENT',$4)`,[t.org,predecessor,t.execution,message]);
    expect(await t.service().dispatch(t.item)).toMatchObject({kind:'NOT_SENT',error:'HANDOFF_WAITING_MESSAGE_DELIVERY'});
    expect((await t.state()).conversation.mode).toBe('BOT');expect(t.fetch).not.toHaveBeenCalled();
    await db.database.pool.query("UPDATE messaging_messages SET state='SENT' WHERE id=$1",[message]);
    expect(await t.service().dispatch(t.item)).toMatchObject({kind:'SENT'});
  });
  it('pauses and fails legacy empty payload without any remote success claim',async()=>{
    const t=await fixture();await db.database.pool.query("UPDATE automation_outbox SET payload='{}' WHERE id=$1",[t.outbox]);
    expect(await t.service().dispatch(t.item)).toEqual({kind:'FAILED',error:'HANDOFF_DESTINATION_REQUIRED_REPUBLISH'});
    expect((await t.state()).operation.state).toBe('ACTION_REQUIRED');expect((await t.state()).conversation.mode).toBe('HUMAN');expect(t.fetch).not.toHaveBeenCalled();
  });
  it.each(['open','assign'] as const)('keeps %s timeout UNKNOWN across restart without blind POST',async phase=>{
    const t=await fixture();t.setTimeout(phase);await expect(t.service().dispatch(t.item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');
    expect((await t.state()).operation.state).toBe('UNKNOWN');await t.expire();
    expect(await t.service().reconcileOnce(t.org)).toMatchObject({state:phase==='assign'?'APPLIED':'UNKNOWN'});
    expect(t.requests.filter(r=>r.method==='POST')).toHaveLength(phase==='assign'?2:1);
  });
  it.each([{teamId:4,agentId:null},{teamId:null,agentId:12}])('reconciles exact manually completed $teamId/$agentId after an open timeout using only canonical reads',async target=>{
    const t=await fixture(target);t.setTimeout('open');await expect(t.service().dispatch(t.item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');
    await t.expire();
    if(target.teamId)t.canonical.meta.team={id:target.teamId};else {t.canonical.meta.assignee={id:target.agentId!,type:'user'};t.canonical.meta.assignee_type='User';}
    t.canonical.updated_at++;await t.record();
    expect(await t.service().reconcileOnce(t.org)).toMatchObject({state:'APPLIED'});
    const state=await t.state();expect(state.operation.confirmed_by).toBe('CANONICAL_RECONCILIATION');expect(state.outbox.status).toBe('SENT');
    expect(t.requests.filter(r=>r.method==='POST')).toHaveLength(1);expect(state.conversation.mode).toBe('HUMAN');
  });
  it('does not repeat either mutation when two workers dispatch the same claimed outbox concurrently',async()=>{
    const t=await fixture();let opened!:()=>void,release!:()=>void;
    const waiting=new Promise<void>(resolve=>{opened=resolve;}),continueOpen=new Promise<void>(resolve=>{release=resolve;});
    t.beforeOpen(async()=>{opened();await continueOpen;});
    const first=t.service().dispatch(t.item);await waiting;
    await expect(t.service().dispatch(t.item)).rejects.toThrow('HANDOFF_RECONCILIATION_REQUIRED');release();
    expect(await first).toMatchObject({kind:'SENT'});expect(t.requests.filter(r=>r.method==='POST')).toHaveLength(2);
    expect((await db.database.pool.query('SELECT id FROM attendance_handoff_operations WHERE organization_id=$1',[t.org])).rowCount).toBe(1);
  });
  it('explicit manual HUMAN to HUMAN action invalidates a handoff already paused by itself',async()=>{
    const t=await fixture();const messaging=createMessagingService({repository:createPostgresMessagingRepository(),runInOrganizationTransaction:db.transact,
      resolveMetaClient:async()=>{throw new Error('UNUSED');},resolveTypebotClient:async()=>{throw new Error('UNUSED');}});
    t.afterOpen(async()=>{expect((await t.state()).conversation.mode).toBe('HUMAN');await messaging.setMode(t.org,t.conversation,'HUMAN');});
    await expect(t.service().dispatch(t.item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');
    expect((await t.state()).session.state).toBe('HUMAN_ACTIVE');expect(t.requests.filter(r=>r.method==='POST')).toHaveLength(1);
    await t.expire();expect(await t.service().reconcileOnce(t.org)).toMatchObject({state:'UNKNOWN'});
  });
  it('recovers a crash after prepared ledger commit without initiating either remote mutation',async()=>{
    const t=await fixture();await db.transact(t.org,tx=>createPostgresHandoffRepository().prepare(tx,t.item));await t.expire();
    expect(await t.service().reconcileOnce(t.org)).toMatchObject({state:'ACTION_REQUIRED'});expect(t.fetch).not.toHaveBeenCalled();
    const state=await t.state();expect(state.outbox.status).toBe('FAILED');expect(state.conversation.mode).toBe('HUMAN');
  });
  it('human callback during HTTP takes channel lock and prevents the subsequent assignment',async()=>{
    const t=await fixture();t.afterOpen(t.human);await expect(t.service().dispatch(t.item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');
    const state=await t.state();expect(state.operation.state).toBe('UNKNOWN');expect(state.session.state).toBe('HUMAN_ACTIVE');
    expect(t.requests.filter(r=>r.method==='POST')).toHaveLength(1);await t.expire();expect(await t.service().reconcileOnce(t.org)).toMatchObject({state:'UNKNOWN'});
  });
  it.each(['credential','owner','cancel','destination'] as const)('blocks a stale %s before the next write',async change=>{
    const t=await fixture();t.afterOpen(async()=>{
      const query=change==='credential'?'UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1':change==='owner'?"UPDATE attendance_owners SET executor='NONE',automation_id=NULL,version=NULL,revision=revision+1 WHERE organization_id=$1":change==='cancel'?"UPDATE automation_executions SET status='CANCELED' WHERE organization_id=$1":"UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1";
      await db.database.pool.query(query,[t.org]);
    });
    await expect(t.service().dispatch(t.item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');expect(t.requests.filter(r=>r.method==='POST')).toHaveLength(1);
    expect((await t.state()).operation.state).toBe('UNKNOWN');
  });
  it('recovers expired claimed HANDOFF without a ledger as actionable paused failure',async()=>{
    const t=await fixture();await t.expire();expect(await t.service().reconcileOnce(t.org)).toMatchObject({state:'ACTION_REQUIRED'});
    const state=await t.state();expect(state.operation.snapshot).toBeNull();expect(state.outbox.status).toBe('FAILED');expect(state.conversation.mode).toBe('HUMAN');expect(t.fetch).not.toHaveBeenCalled();
  });
  it('isolates two companies with the same numeric remote IDs and rejects forged tenant scope',async()=>{
    const a=await fixture(),b=await fixture();expect(await a.service().dispatch(a.item)).toMatchObject({kind:'SENT'});
    expect((await db.transact(b.org,tx=>tx.query('SELECT * FROM attendance_handoff_operations WHERE outbox_id=$1',[a.outbox]))).rows).toEqual([]);
    await expect(b.service().dispatch({...a.item,organizationId:b.org})).rejects.toThrow('CHANNEL_NOT_FOUND');
    expect(b.fetch).not.toHaveBeenCalled();expect((await b.state()).conversation.mode).toBe('BOT');
    await expect(db.transact(b.org,tx=>tx.query(`INSERT INTO attendance_handoff_operations(organization_id,outbox_id,execution_id,channel_id,conversation_id,lease_token,state)
      VALUES($1,$2,$3,$4,$5,$6,'ACTION_REQUIRED')`,[b.org,a.outbox,a.execution,b.channel,b.conversation,randomUUID()]))).rejects.toMatchObject({code:'23503'});
  });
  it('keeps UNKNOWN operations in lifecycle pending accounting and required RLS readiness',async()=>{
    const t=await fixture();t.setTimeout('open');await expect(t.service().dispatch(t.item)).rejects.toThrow();
    expect(await probeRequiredRuntimeSchema(sql=>db.database.pool.query(sql))).toBe(true);
    expect((await db.database.pool.query('SELECT lifecycle_pending_count($1,NULL,NULL) AS count',[t.org])).rows[0].count).not.toBe('0');
    const client=await db.database.pool.connect();try{await client.query('BEGIN');await client.query('ALTER TABLE attendance_handoff_operations NO FORCE ROW LEVEL SECURITY');
      expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(false);
    }finally{await client.query('ROLLBACK');client.release();}
  });
});
