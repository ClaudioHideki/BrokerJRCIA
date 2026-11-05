import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createPostgresMessagingRepository} from '../../src/modules/messaging/repository.js';
import {ensureQrChannel} from '../../src/modules/messaging/qr-service.js';
import {persistQrContactEvent} from '../../src/modules/messaging/qr-contact-persistence.js';
import {persistQrHistoryPage} from '../../src/modules/history-import/qr-writer.js';
import type {HistoryRecord} from '../../src/modules/history-import/contract.js';

const repository=createPostgresMessagingRepository(),liveAt=new Date('2026-11-04T12:00:00.000Z');
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
let imported:Awaited<ReturnType<typeof importAfterLive>>;
async function importAfterLive(){
 const tenant=await seedAttendanceTenant(db.database,false);
 const channel=await db.transact(tenant.org,async tx=>{
  const provider=(await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic chronology') RETURNING id",[tenant.org])).rows[0].id;
  const instance=(await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Chronology',$3,'CONNECTED') RETURNING id",[tenant.org,provider,randomUUID()])).rows[0].id;
  return ensureQrChannel(tx,tenant.org,instance);
 });
 await db.transact(tenant.org,async tx=>{
  await persistQrContactEvent(tx,channel,{kind:'message',upstreamMessageId:'synthetic-live',externalId:'15550000001',displayName:'Synthetic current',content:{type:'TEXT',text:'Live T2'},occurredAt:liveAt});
  await persistQrContactEvent(tx,channel,{kind:'message',upstreamMessageId:'synthetic-middle',externalId:'15550000002',displayName:'Synthetic middle',content:{type:'TEXT',text:'Live middle'},occurredAt:new Date('2026-11-04T11:00:00.000Z')});
 });
 const before=(await db.transact(tenant.org,tx=>tx.query<{conversation_id:string;id:string;sequence_number:string}>("SELECT conversation_id,id,sequence_number FROM messaging_messages WHERE channel_id=$1 AND upstream_message_id='synthetic-live'",[channel.id]))).rows[0]!;
 const effects=()=>db.transact(tenant.org,async tx=>({
  botJobs:(await tx.query('SELECT count(*)::int AS n FROM messaging_bot_jobs WHERE organization_id=$1',[tenant.org])).rows[0].n,
  outbox:(await tx.query('SELECT count(*)::int AS n FROM messaging_outbox WHERE organization_id=$1',[tenant.org])).rows[0].n,
  integrationJobs:(await tx.query('SELECT count(*)::int AS n FROM integration_jobs WHERE organization_id=$1',[tenant.org])).rows[0].n,
 }));
 const baselineEffects=await effects();
 const records:HistoryRecord[]=Array.from({length:101},(_,ordinal)=>({ordinal,providerMessageId:`synthetic-history-${ordinal}`,remoteJid:'15550000001@s.whatsapp.net',fromMe:false,
  messageTimestamp:Math.floor(new Date('2026-11-03T12:00:00.000Z').getTime()/1000)+ordinal,text:`History T1 ${ordinal}`,displayName:'Synthetic old'}));
 await db.transact(tenant.org,tx=>persistQrHistoryPage(tx,tenant.org,channel.id,records.slice(0,100)));
 await db.transact(tenant.org,tx=>persistQrHistoryPage(tx,tenant.org,channel.id,records.slice(100)));
 return {...tenant,channel,before,records,effects,baselineEffects};
}
beforeAll(async()=>{db=await attendanceDatabase();imported=await importAfterLive();},180000);
afterAll(async()=>{await db?.dispose();});

it('does not regress the last conversation date or its position after older history arrives last',async()=>{
 const conversations=await db.transact(imported.org,tx=>repository.listConversations(tx,imported.org,imported.channel.id,100));
 expect(conversations[0]?.id).toBe(imported.before.conversation_id);
 expect(conversations.find(item=>item.id===imported.before.conversation_id)?.lastMessageAt).toEqual(liveAt);
 expect(await imported.effects()).toEqual(imported.baselineEffects);
});
it('keeps the live message in the latest chronological window after more than 100 historical inserts',async()=>{
 const messages=await db.transact(imported.org,tx=>repository.listConversationMessages(tx,imported.org,imported.before.conversation_id,100));
 expect(messages).toHaveLength(100);expect(messages.at(-1)?.id).toBe(imported.before.id);
 expect(messages[0]?.upstreamMessageId).toBe('synthetic-history-2');
 expect(messages.map(item=>item.createdAt.getTime())).toEqual(messages.map(item=>item.createdAt.getTime()).sort((a,b)=>a-b));
 const sequence=(await db.transact(imported.org,tx=>tx.query<{sequence_number:string;is_historical:boolean}>("SELECT sequence_number,is_historical FROM messaging_messages WHERE organization_id=$1 AND conversation_id=$2 ORDER BY sequence_number",[imported.org,imported.before.conversation_id]))).rows;
 expect(sequence).toHaveLength(102);expect(sequence[0]).toEqual({sequence_number:imported.before.sequence_number,is_historical:false});
 expect(sequence.slice(1).every(row=>row.is_historical&&BigInt(row.sequence_number)>BigInt(imported.before.sequence_number))).toBe(true);
 expect(await imported.effects()).toEqual(imported.baselineEffects);
});
it('preserves a same-timestamp automation turn ordinal despite UUID order opposing ingestion sequence',async()=>{
 const tenant=await seedAttendanceTenant(db.database,false),low='00000000-0000-4000-8000-000000000001',high='00000000-0000-4000-8000-000000000002';
 await db.transact(tenant.org,async tx=>{for(const [ordinal,id] of [high,low].entries())await tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,created_at,is_historical,idempotency_key,idempotency_body_hash)
  VALUES($1,$2,$3,$4,'OUTGOING','AUTOMATION',jsonb_build_object('type','TEXT','text',$6::text),'SENT',$5,false,$7,encode(digest(convert_to($6::text,'UTF8'),'sha256'),'hex'))`,
  [id,tenant.org,tenant.channel,tenant.conversation,liveAt,`Synthetic turn ${ordinal+1}`,`bot:${tenant.conversation}:${ordinal+1}`]);});
 expect((await db.transact(tenant.org,tx=>repository.listConversationMessages(tx,tenant.org,tenant.conversation,1))).map(item=>item.id)).toEqual([low]);
 const messages=await db.transact(tenant.org,tx=>repository.listConversationMessages(tx,tenant.org,tenant.conversation,2));
 expect(messages.map(item=>item.id)).toEqual([high,low]);
 expect(messages.map(item=>item.content.type==='TEXT'?item.content.text:'')).toEqual(['Synthetic turn 1','Synthetic turn 2']);
});
it('keeps chronological reads inside the authorized tenant even for known foreign IDs',async()=>{
 const other=await seedAttendanceTenant(db.database,false);
 expect(await db.transact(other.org,tx=>repository.listConversationMessages(tx,imported.org,imported.before.conversation_id,100))).toEqual([]);
 expect(await db.transact(other.org,tx=>repository.listConversations(tx,imported.org,imported.channel.id,100))).toEqual([]);
 expect(await db.transact(imported.org,tx=>repository.listConversationMessages(tx,imported.org,other.conversation,100))).toEqual([]);
});
