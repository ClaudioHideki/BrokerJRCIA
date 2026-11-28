import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import type { Pool } from 'pg';
import { verifyDirectStores } from '../../src/modules/integrations/direct-receipt-stores.js';
import { reconcileDirectReplyFromStores } from '../../src/modules/integrations/reconcile-direct-reply.js';

vi.mock('../../src/modules/integrations/direct-receipt-stores.js',()=>({verifyDirectStores:vi.fn().mockResolvedValue(true)}));

describe('direct Evolution receipt for a single Chatwoot reply',()=>{
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async()=>{ db=await attendanceDatabase(); },600000);
  afterAll(async()=>{await db?.dispose();});
  async function fixture(){
    const t=await seedAttendanceTenant(db.database), job=randomUUID();
    const body='synthetic text',key='synthetic-direct-key',phone='15550001111';
    const hash=createHash('sha256').update(body).digest('hex');
    await db.database.pool.query('UPDATE messaging_contacts SET external_id=$2 WHERE id=(SELECT contact_id FROM messaging_conversations WHERE id=$1)',[t.conversation,phone]);
    await db.database.pool.query("INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) VALUES($1,$2,$3,41,'synthetic',52)",[t.org,t.integration,t.conversation]);
    await db.database.pool.query("INSERT INTO integration_jobs(organization_id,integration_id,id,kind,dedupe_key,payload) VALUES($1,$2,$3,'CHATWOOT_REPLY','reply:1:7:9:701',$4)",[t.org,t.integration,job,{conversationId:52,messageId:701,destinationRevision:1,content:{type:'TEXT',text:body}}]);
    const original={accountId:7,inboxId:9,conversationId:52,messageId:701};
    const instance='historic-instance-id',peer=phone+'@s.whatsapp.net';
    const evidence={protocol:'DIRECT_EVOLUTION_RECEIPT_V1',organizationId:t.org,integrationId:t.integration,channelId:t.channel,jobId:job,
      origin:'https://'+t.org+'.example.test',destinationRevision:1,credentialRevision:1,
      rails:{...original,obligationId:randomUUID(),intentId:null as string|null,sourceId:'WAID:'+key,bodySha256:hash,attachmentCount:0,humanPublic:true},
      historicalBinding:{instanceId:instance,generation:'synthetic-generation',evidenceSha256:'b'.repeat(64)},
      evolution:{...original,instanceId:instance,rowId:'provider-row',key,peer,fromMe:true,bodySha256:hash,partCount:1,matchingRows:1},
      ack:{instanceId:instance,messageRowId:'provider-row',rowId:'provider-update',key,peer,fromMe:true,status:'READ'}};
    async function invoke(value=evidence){
      const bytes=Buffer.from(JSON.stringify(value));
      return db.transact(t.org,tx=>reconcileDirectReplyFromStores(tx,bytes,Buffer.alloc(0),'',{} as Pool,{} as Pool,{organizationId:t.org,jobId:job}));
    }
    return {...t,evidence,invoke,job};
  }
  it('commits once under concurrent callers and emits no messaging effect',async()=>{
    const t=await fixture();
    const results=await Promise.all([t.invoke(),t.invoke()]);
    expect(results.map(x=>x.result).sort()).toEqual(['APPLIED','UNCHANGED']);
    expect((await db.database.pool.query('SELECT status,message_id,payload FROM integration_jobs WHERE id=$1',[t.job])).rows[0])
      .toMatchObject({status:'SUCCEEDED',message_id:null,payload:{directEvolutionReceipt:{state:'READ'}}});
    expect((await db.database.pool.query('SELECT count(*)::int n FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0].n).toBe(0);
  });
  it('accepts a native intent only against the applied observation of this original',async()=>{
    const t=await fixture(),intent=randomUUID(),obs=randomUUID();
    t.evidence.rails.intentId=intent;
    await db.database.pool.query(`INSERT INTO chatwoot_attendance_observations(organization_id,id,integration_id,channel_id,destination_revision,
      credential_revision,account_id,inbox_id,remote_conversation_id,event_key,event,disposition,conversation_id)
      VALUES($1,$2,$3,$4,1,1,7,9,52,'message:701',$5,'APPLIED',$6)`,
      [t.org,obs,t.integration,t.channel,{kind:'HUMAN_PUBLIC',senderId:7,mayForwardReply:true,remoteMessageId:701,remoteConversationId:52,outboundIntentId:intent},t.conversation]);
    await db.database.pool.query("UPDATE integration_jobs SET payload=payload||$2::jsonb WHERE id=$1",[t.job,{attendanceKind:'HUMAN_PUBLIC',attendanceObservationId:obs,outboundIntentId:intent}]);
    expect((await t.invoke()).receipt.intentId).toBe(intent);
  });
  it('advances the same original once from delivered to read and keeps the highest receipt',async()=>{
    const t=await fixture(),delivered=structuredClone(t.evidence);
    delivered.ack.status='DELIVERY_ACK';delivered.ack.rowId='first-ack';
    expect((await t.invoke(delivered)).receipt.state).toBe('DELIVERED');
    expect((await t.invoke()).receipt.state).toBe('READ');
    expect((await t.invoke(delivered)).receipt.state).toBe('READ');
    const other=structuredClone(t.evidence);other.historicalBinding.generation='other-generation';
    await expect(t.invoke(other)).rejects.toThrow();
  });
  it('waits for a real concurrent claim and refuses the committed active lease',async()=>{
    const t=await fixture(),claim=await db.database.pool.connect();
    try{
      await claim.query('BEGIN');
      await claim.query("UPDATE integration_jobs SET status='RUNNING',lease_token=$2,lease_expires_at=now()+interval '1 min' WHERE id=$1",[t.job,randomUUID()]);
      const attempt=expect(t.invoke()).rejects.toThrow();
      await claim.query('COMMIT');await attempt;
    }finally{await claim.query('ROLLBACK');claim.release();}
    expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1',[t.job])).rows[0].status).toBe('RUNNING');
  });

  it.each(['lease','peer','scope','provider-store','duplicate','partial','destination','provider','qr','attachments','observation','priorError'] as const)('keeps an inconclusive original armed only behind the review hold (%s)',async which=>{
    const t=await fixture(),v=t.evidence;
    if(which==='observation')await db.database.pool.query("UPDATE integration_jobs SET payload=payload||jsonb_build_object('attendanceObservationId',$2::text) WHERE id=$1",[t.job,randomUUID()]);
    if(which==='priorError')await db.database.pool.query("UPDATE integration_jobs SET last_error='SYNTHETIC_UNCERTAINTY' WHERE id=$1",[t.job]);
    if(which==='lease') await db.database.pool.query("UPDATE integration_jobs SET status='RUNNING',lease_token=$2,lease_expires_at=now()+interval '1 min' WHERE id=$1",[t.job,randomUUID()]);
    if(which==='peer')v.ack.peer='other@s.whatsapp.net';
    if(which==='scope')v.rails.inboxId++;
    if(which==='partial')v.evolution.partCount=2;
    if(which==='destination')v.destinationRevision++;
    if(which==='provider')v.ack.instanceId='wrong-instance';
    if(which==='duplicate')v.evolution.matchingRows=2;
    if(which==='attachments')await db.database.pool.query("UPDATE integration_jobs SET payload=payload||'{\"attachments\":[{\"id\":1,\"kind\":\"image\"}]}'::jsonb WHERE id=$1",[t.job]);
    if(which==='qr'){
      const m=(await db.database.pool.query("INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,'OUTGOING','OPERATOR','{\"type\":\"TEXT\",\"text\":\"other\"}','ACCEPTED') RETURNING id",[t.org,t.channel,t.conversation])).rows[0];
      await db.database.pool.query("INSERT INTO qr_dispatch_attempts(organization_id,channel_id,conversation_id,message_id,lease_token,lease_expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 min')",[t.org,t.channel,t.conversation,m.id,randomUUID()]);
    }
    if(which==='provider-store')vi.mocked(verifyDirectStores).mockRejectedValueOnce(new Error('DIRECT_STORES_DISAGREE'));
    await expect(t.invoke(v)).rejects.toThrow();
    expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1',[t.job])).rows[0].status).toBe(which==='lease'?'RUNNING':'PENDING');
  });
});
