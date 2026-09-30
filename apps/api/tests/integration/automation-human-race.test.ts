import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createAutomationService, createEventRouter, createExecutionService, createOutboxDispatcher } from '../../src/modules/automations/service.js';
import { initializeChatwootAttendanceMap, recordChatwootAttendanceEvent } from '../../src/modules/integrations/chatwoot-attendance-store.js';

const graph = { nodes: [
  { id:'start', type:'start', label:'Start', position:{x:0,y:0}, data:{} },
  { id:'text', type:'message', label:'Text', position:{x:100,y:0}, data:{text:'Olá'} },
  { id:'end', type:'end', label:'End', position:{x:200,y:0}, data:{} },
], edges:[{id:'a',source:'start',target:'text',port:'next'},{id:'b',source:'text',target:'end',port:'next'}] };
describe('automation admission and dispatch authority', () => {
  let db:Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async()=>{db=await attendanceDatabase();},60000);
  afterAll(async()=>{await db?.dispose();});
  async function fixture(remote=false) {
    const t=await seedAttendanceTenant(db.database,false);
    await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)',[t.org]);
    const service=createAutomationService({transact:db.transact,enabled:true});
    const draft=await service.create(t.org,{name:'Control fixture',graph});
    await service.publish(t.org,draft.id,draft.draft.revision);
    await service.bind(t.org,draft.id,{channelId:t.channel});
    await db.database.pool.query("update messaging_conversations set mode='BOT' where organization_id=$1 and id=$2",[t.org,t.conversation]);
    if(remote) {
      await db.database.pool.query("insert into chatwoot_accounts(organization_id,base_url,account_id,status) values($1,$2,7,'READY')",[t.org,`https://${t.org}.example.test`]);
      await db.database.pool.query("insert into chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) values($1,$2,$3,9,'test','READY')",[t.integration,t.org,t.channel]);
      await db.database.pool.query('update attendance_owners set integration_id=$3 where organization_id=$1 and channel_id=$2',[t.org,t.channel,t.integration]);
    }
    const worker=createExecutionService({transact:db.transact,enabled:true});
    const router=createEventRouter({transact:db.transact,enabled:true});
    const route=()=>router.route(t.org,{channelId:t.channel,conversationId:t.conversation,eventKey:randomUUID(),text:'Oi'});
    const dispatch=vi.fn().mockResolvedValue({kind:'SENT',remoteReference:'synthetic'});
    const outbox=createOutboxDispatcher({transact:db.transact,enabled:true},{dispatch});
    const ready=()=>db.transact(t.org,tx=>initializeChatwootAttendanceMap(tx,{...t.scope,credentialRevision:1},
      {conversationId:t.conversation,remoteConversationId:51,canonical:{id:51,account_id:7,inbox_id:9,status:'pending',updated_at:100,meta:{assignee:null,assignee_type:null,team:null}}}));
    return {...t,worker,route,dispatch,outbox,ready};
  }
  it('does not start another bot conversation after a local human takeover',async()=>{
    const t=await fixture();
    await db.database.pool.query("update messaging_conversations set mode='HUMAN' where organization_id=$1 and id=$2",[t.org,t.conversation]);
    expect(await t.route()).toMatchObject({execution:null});
    expect(await t.worker.runOnce(t.org)).toEqual({processed:false});
  });
  it('holds a queued turn until the remote conversation map is confirmed ready',async()=>{
    const t=await fixture(true); await t.route();
    expect(await t.worker.runOnce(t.org)).toEqual({processed:false});
    await t.ready();
    expect(await t.worker.runOnce(t.org)).toMatchObject({processed:true,status:'COMPLETED'});
  });
  it('does not claim a pending effect after local human control changes',async()=>{
    const t=await fixture(); await t.route(); await t.worker.runOnce(t.org);
    await db.database.pool.query("update messaging_conversations set mode='HUMAN' where organization_id=$1 and id=$2",[t.org,t.conversation]);
    expect(await t.outbox.runOnce(t.org)).toEqual({processed:false});
    expect(t.dispatch).not.toHaveBeenCalled();
  });
  it('holds pending output when remote evidence needs reconciliation, without consuming the effect',async()=>{
    const t=await fixture(true); await t.route(); await t.ready(); await t.worker.runOnce(t.org);
    await db.database.pool.query("update chatwoot_attendance_controls set state='RECONCILE',revision=revision+1 where organization_id=$1 and conversation_id=$2",[t.org,t.conversation]);
    expect(await t.outbox.runOnce(t.org)).toEqual({processed:false});
    expect(t.dispatch).not.toHaveBeenCalled();
    expect((await db.database.pool.query('select status from automation_outbox where organization_id=$1',[t.org])).rows).toEqual([{status:'PENDING'}]);
  });
  it('invalidates pending outputs after an authenticated human event and never resumes on late pending',async()=>{
    const t=await fixture(true); await t.route(); await t.ready(); await t.worker.runOnce(t.org);
    await db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,{...t.scope,credentialRevision:1},{
      event:'message_created',id:83,account:{id:7},inbox:{id:9},conversation:{id:51,inbox_id:9},
      message_type:'outgoing',private:false,sender:{id:12,type:'user'},content:'synthetic human response'}));
    await t.ready();
    expect(await t.outbox.runOnce(t.org)).toEqual({processed:false});
    expect(t.dispatch).not.toHaveBeenCalled();
    expect((await db.database.pool.query('select status from automation_outbox where organization_id=$1',[t.org])).rows).toEqual([{status:'CANCELED'}]);
  });
});
