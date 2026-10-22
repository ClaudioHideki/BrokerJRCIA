import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createPartnerEventService} from '../../src/modules/partner-events/service.js';
import {createIntegrationSecrets} from '../../src/modules/integrations/secrets.js';
import {claimDelivery,settleDelivery,createPartnerEventWorker} from '../../src/modules/partner-events/worker.js';
import {seedMetaConnection} from './helpers/meta-fixture.js';

describe('durable generic partner events / real PostgreSQL',()=>{
 let db:Awaited<ReturnType<typeof attendanceDatabase>>;
 let a:Awaited<ReturnType<typeof seedAttendanceTenant>>,b:typeof a;
 let service:ReturnType<typeof createPartnerEventService>;
 const secrets=createIntegrationSecrets(Buffer.alloc(32,7).toString('base64'));
 beforeAll(async()=>{
  db=await attendanceDatabase();a=await seedAttendanceTenant(db.database,false);b=await seedAttendanceTenant(db.database,false);
  service=createPartnerEventService({transact:db.transact,secrets});
 });
 afterAll(async()=>{await db?.dispose();});
 it('captures source message/state atomically, isolates tenants and forbids app event mutation',async()=>{
  const endpoint=await service.create(a.org,{url:'https://partner.example/hooks'},randomUUID()),id=randomUUID();
  await db.transact(a.org,async tx=>{
   await tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state)
    VALUES($1,$2,$3,$4,'INCOMING','CONTACT','{"type":"TEXT","text":"synthetic"}','DELIVERED')`,[id,a.org,a.channel,a.conversation]);
  });
  const events=await service.events(a.org,{limit:100});
  const event=events.data.find(row=>row.data.messageId===id)!;
  expect(event).toMatchObject({type:'message.received',data:{messageId:id,channelId:a.channel,conversationId:a.conversation,content:{type:'TEXT',text:'synthetic'}}});
  expect((await service.events(b.org,{limit:100})).data).toEqual([]);
  await expect(db.transact(b.org,tx=>tx.query(`SELECT * FROM partner_events WHERE id=$1`,[event.eventId]).then(result=>{expect(result.rowCount).toBe(0);}))).resolves.toBeUndefined();
  await expect(db.transact(a.org,tx=>tx.query(`UPDATE partner_events SET payload='{}' WHERE id=$1`,[event.eventId]))).rejects.toMatchObject({code:'42501'});
  const before=(await service.events(a.org,{limit:100})).data.length;
  await expect(db.transact(a.org,async tx=>{await tx.query(`UPDATE messaging_messages SET state='READ' WHERE organization_id=$1 AND id=$2`,[a.org,id]);throw new Error('ROLLBACK');})).rejects.toThrow('ROLLBACK');
  expect((await service.events(a.org,{limit:100})).data.length).toBe(before);
  const seen:string[]=[];
  const worker=createPartnerEventWorker({transact:db.transact,openSecret:claim=>secrets.decrypt(`partner-webhook:${claim.organizationId}:${claim.endpointId}`,claim.encryptedSecret),send:async(_url,init)=>{seen.push(String((init!.headers as Record<string,string>)['x-jrc-event-id']));return new Response(null,{status:200});}});
  expect(await worker.processOne(a.org)).toBe(true);expect(seen).toEqual([event.eventId]);
  expect(await worker.processOne(a.org)).toBe(false);
  await service.revoke(a.org,endpoint.endpoint.id);
  const list=await service.list(a.org);expect(JSON.stringify(list)).not.toContain(endpoint.signingSecret);expect(list.data[0]!.status).toBe('REVOKED');
 });
 it('deduplicates one event per state change and fanout per endpoint and cancels revoked queue',async()=>{
  const first=await service.create(b.org,{url:'https://partner.example/b'},randomUUID()),second=await service.create(b.org,{url:'https://partner.example/c'},randomUUID()),id=randomUUID();
  await db.transact(b.org,async tx=>{
   await tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR','{"type":"TEXT","text":"synthetic"}','ACCEPTED')`,[id,b.org,b.channel,b.conversation]);
   await tx.query(`UPDATE messaging_messages SET state='SENT' WHERE organization_id=$1 AND id=$2`,[b.org,id]);
   await tx.query(`UPDATE messaging_messages SET state='SENT' WHERE organization_id=$1 AND id=$2`,[b.org,id]);
  });
  expect((await service.events(b.org,{limit:100})).data.map(event=>event.type)).toEqual(['message.created','message.status']);
  expect((await service.deliveries(b.org,{limit:100})).data).toHaveLength(4);
  await service.revoke(b.org,first.endpoint.id);
  const rows=(await service.deliveries(b.org,{limit:100})).data;
  expect(rows.filter(row=>row.endpointId===first.endpoint.id).every(row=>row.status==='CANCELLED')).toBe(true);
  expect(rows.filter(row=>row.endpointId===second.endpoint.id).every(row=>row.status==='PENDING')).toBe(true);
  const cursor=(await service.events(b.org,{limit:1})).nextCursor;
  expect((await service.events(b.org,{limit:100,after:cursor})).data).toHaveLength(1);
 });
 it('recovers an expired claim with the same event ID and fences a stale completion',async()=>{
  const tenant=await seedAttendanceTenant(db.database,false),id=randomUUID(),key=randomUUID();
  const endpoint=await service.create(tenant.org,{url:'https://partner.example/recovery'},key);
  expect(await service.create(tenant.org,{url:'https://partner.example/recovery'},key)).toMatchObject({endpoint:endpoint.endpoint,signingSecret:endpoint.signingSecret,replayed:true});
  await db.transact(tenant.org,tx=>tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,$4,'INCOMING','CONTACT','{"type":"TEXT","text":"synthetic"}','DELIVERED')`,[id,tenant.org,tenant.channel,tenant.conversation]));
  const stale=await db.transact(tenant.org,tx=>claimDelivery(tx,tenant.org));expect(stale).not.toBeNull();
  expect(await db.transact(tenant.org,tx=>claimDelivery(tx,tenant.org))).toBeNull();
  await db.transact(tenant.org,tx=>tx.query(`UPDATE partner_event_deliveries SET lease_expires_at=now()-interval '1 second' WHERE organization_id=$1 AND id=$2`,[tenant.org,stale!.deliveryId]));
  const recovered=await db.transact(tenant.org,tx=>claimDelivery(tx,tenant.org));
  expect(recovered!.eventId).toBe(stale!.eventId);expect(recovered!.leaseToken).not.toBe(stale!.leaseToken);
  await db.transact(tenant.org,tx=>settleDelivery(tx,stale!,{status:'DELIVERED',attempts:1,errorCode:null,delayMs:0}));
  expect((await service.deliveries(tenant.org,{limit:100})).data[0]!.status).toBe('RUNNING');
  await service.revoke(tenant.org,endpoint.endpoint.id);
  const send=()=>{throw new Error('Revoked endpoint must not send');};
  const worker=createPartnerEventWorker({transact:db.transact,openSecret:()=> 'unused',send});
  expect(await worker.processOne(tenant.org)).toBe(false);
 });
 it('captures Meta connection state using a generic channel contract',async()=>{
  const tenant=await seedAttendanceTenant(db.database,false),id=randomUUID();
  await seedMetaConnection(db.database.pool,{id,org:tenant.org,channel:tenant.channel});
  expect((await service.events(tenant.org,{limit:100})).data).toEqual([]);
  await service.create(tenant.org,{url:'https://partner.example/meta'},randomUUID());
  await db.transact(tenant.org,tx=>tx.query(`UPDATE meta_connections SET status='PENDING' WHERE organization_id=$1 AND id=$2`,[tenant.org,id]));
  const events=(await service.events(tenant.org,{limit:100})).data;
  expect(events).toHaveLength(1);expect(events[0]).toMatchObject({type:'connection.status',data:{connectionId:id,channelId:tenant.channel,provider:'META',status:'PENDING'}});
 });
 it('prunes partner copies after 30 days and reports an expired cursor without touching messages',async()=>{
  const tenant=await seedAttendanceTenant(db.database,false),id=randomUUID();
  await service.create(tenant.org,{url:'https://partner.example/retention'},randomUUID());
  await db.transact(tenant.org,tx=>tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,$4,'INCOMING','CONTACT','{"type":"TEXT","text":"synthetic"}','DELIVERED')`,[id,tenant.org,tenant.channel,tenant.conversation]));
  await db.transact(tenant.org,tx=>tx.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"synthetic second"}','DELIVERED')`,[tenant.org,tenant.channel,tenant.conversation]));
  const first=await service.events(tenant.org,{limit:100});
  // Expire the HIGHER cursor while the lower cursor is still retained. A minimum
  // retained cursor alone cannot detect this gap; the persisted watermark must.
  await db.database.pool.query(`UPDATE partner_events SET occurred_at=now()-interval '31 days' WHERE organization_id=$1 AND id=$2`,[tenant.org,first.data[1]!.eventId]);
  await db.transact(tenant.org,tx=>tx.query('SELECT partner_publish_events()'));
  await expect(service.events(tenant.org,{limit:100,after:first.data[0]!.cursor})).rejects.toThrow('EVENT_CURSOR_EXPIRED');
  const retained=await service.events(tenant.org,{limit:100,after:'0'});
  expect(retained.data).toHaveLength(1);expect(retained.earliestCursor).toBe(first.data[0]!.cursor);expect(retained.lastPrunedCursor).toBe(first.data[1]!.cursor);
  await db.database.pool.query(`UPDATE partner_events SET occurred_at=now()-interval '31 days' WHERE organization_id=$1`,[tenant.org]);
  await db.transact(tenant.org,tx=>tx.query('SELECT partner_publish_events()'));
  expect((await service.events(tenant.org,{limit:100,after:'0'})).data).toEqual([]);
  expect((await service.events(tenant.org,{limit:100,after:first.nextCursor})).data).toEqual([]);
  expect((await service.deliveries(tenant.org,{limit:100})).data).toEqual([]);
  expect((await db.transact(tenant.org,tx=>tx.query(`SELECT 1 FROM messaging_messages WHERE organization_id=$1 AND id=$2`,[tenant.org,id]))).rowCount).toBe(1);
 });
 it('allocates cursors after source commit, including a transaction that commits late',async()=>{
  const tenant=await seedAttendanceTenant(db.database,false),firstId=randomUUID(),secondId=randomUUID();
  await service.create(tenant.org,{url:'https://partner.example/ordering'},randomUUID());
  const source=await db.database.pool.connect();
  const sql=`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,$4,'INCOMING','CONTACT','{"type":"TEXT","text":"synthetic"}','DELIVERED')`;
  try{
   await source.query('BEGIN');await source.query(sql,[firstId,tenant.org,tenant.channel,tenant.conversation]);
   await db.transact(tenant.org,tx=>tx.query(sql,[secondId,tenant.org,tenant.channel,tenant.conversation]));
   const observed=await service.events(tenant.org,{limit:100});expect(observed.data.map(event=>event.data.messageId)).toEqual([secondId]);
   await source.query('COMMIT');
   const late=await service.events(tenant.org,{limit:100,after:observed.nextCursor});
   expect(late.data.map(event=>event.data.messageId)).toEqual([firstId]);
  }finally{await source.query('ROLLBACK');source.release();}
 });
 it('does not capture imported history and cancels fanout that commits after revocation',async()=>{
  const tenant=await seedAttendanceTenant(db.database,false),historical=randomUUID(),live=randomUUID();
  const endpoint=await service.create(tenant.org,{url:'https://partner.example/revocation'},randomUUID());
  await db.transact(tenant.org,tx=>tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,is_historical) VALUES($1,$2,$3,$4,'INCOMING','CONTACT','{"type":"TEXT","text":"history"}','DELIVERED',true)`,[historical,tenant.org,tenant.channel,tenant.conversation]));
  expect((await service.events(tenant.org,{limit:100})).data).toEqual([]);
  const source=await db.database.pool.connect();
  try{
   await source.query('BEGIN');
   await source.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,$4,'INCOMING','CONTACT','{"type":"TEXT","text":"live"}','DELIVERED')`,[live,tenant.org,tenant.channel,tenant.conversation]);
   await service.revoke(tenant.org,endpoint.endpoint.id);
   await source.query('COMMIT');
   await db.transact(tenant.org,tx=>tx.query('SELECT partner_publish_events()'));
   expect((await service.deliveries(tenant.org,{limit:100})).data.map(row=>row.status)).toEqual(['CANCELLED']);
  }finally{await source.query('ROLLBACK');source.release();}
 });
 it('opts in by a current partner scope without requiring any remote URL',async()=>{
  const tenant=await seedAttendanceTenant(db.database,false),key=randomUUID();
  await db.database.pool.query(`INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes) VALUES($1::uuid,$2,'synthetic-partner-key',$1::text,'synthetic-fixture',ARRAY['instances:read'])`,[key,tenant.org]);
  const write=()=>db.transact(tenant.org,tx=>tx.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"synthetic"}','DELIVERED')`,[tenant.org,tenant.channel,tenant.conversation]));
  await write();expect((await service.events(tenant.org,{limit:100})).data).toEqual([]);
  await db.database.pool.query(`UPDATE api_keys SET scopes=ARRAY['messaging:read'] WHERE id=$1`,[key]);
  await write();expect((await service.events(tenant.org,{limit:100})).data.map(event=>event.type)).toEqual(['message.received']);
  expect((await service.list(tenant.org)).data).toEqual([]);
 });
 it('marks the full logical retention gap before bounded physical pruning completes',async()=>{
  const tenant=await seedAttendanceTenant(db.database,false);
  await db.database.pool.query(`INSERT INTO partner_events(organization_id,event_type,payload,occurred_at,sequence_number)
   SELECT $1,'message.received','{}',now()-interval '31 days',nextval('partner_event_order_seq') FROM generate_series(1,1001)`,[tenant.org]);
  const range=(await db.database.pool.query(`SELECT min(sequence_number)::text AS first,max(sequence_number)::text AS last FROM partner_events WHERE organization_id=$1`,[tenant.org])).rows[0]!;
  await db.transact(tenant.org,tx=>tx.query('SELECT partner_publish_events()'));
  expect((await db.database.pool.query(`SELECT count(*)::int AS count FROM partner_events WHERE organization_id=$1`,[tenant.org])).rows[0]!.count).toBe(501);
  expect((await db.transact(tenant.org,tx=>tx.query(`SELECT last_pruned_cursor::text AS cursor FROM partner_event_cursor_state WHERE organization_id=$1`,[tenant.org]))).rows[0]!.cursor).toBe(range.last);
  await expect(service.events(tenant.org,{after:range.first,limit:100})).rejects.toThrow('EVENT_CURSOR_EXPIRED');
 });
});
