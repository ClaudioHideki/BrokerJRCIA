import {createHash,createHmac,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createQrMessagingService,ensureQrChannel} from '../../src/modules/messaging/qr-service.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
const signingKey='synthetic-origin-signing-key-'.repeat(2);
beforeAll(async()=>{db=await attendanceDatabase();});
afterAll(async()=>{await db?.dispose();});
async function fixture(){
  const tenant=await seedAttendanceTenant(db.database,false),engine='origin-'+randomUUID();
  const {instance,channel}=await db.transact(tenant.org,async tx=>{
    const provider=(await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Origin QR') RETURNING id",[tenant.org])).rows[0].id;
    const instance=(await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Origin',$3,'CONNECTED') RETURNING id",[tenant.org,provider,engine])).rows[0].id;
    return {instance,channel:(await ensureQrChannel(tx,tenant.org,instance)).id};
  });
  const service=(transact=db.transact)=>createQrMessagingService({baseUrl:'https://engine.test',apiKey:'synthetic',signingKey,webhookOrigin:'https://broker.test',transact,
    resolveChannel:async id=>id===channel?{organizationId:tenant.org,instanceId:instance}:undefined});
  const auth='Bearer '+createHmac('sha256',signingKey).update(`qr-webhook\0${tenant.org}\0${channel}`).digest('base64url');
  const payload={event:'messages.upsert',instance:engine,data:{key:{id:'synthetic-'+randomUUID(),fromMe:false,remoteJid:'15550000001@s.whatsapp.net'},message:{conversation:'Synthetic durable fact'},messageTimestamp:Math.floor(Date.now()/1000)}};
  const receipt={sourceEventId:randomUUID(),contentSha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
  return {...tenant,instance,channel,auth,payload,receipt,service};
}
it('returns a correlated durable receipt only after the message transaction commits',async()=>{
  const t=await fixture();
  const ingest=t.service().ingest as (...args:unknown[])=>Promise<unknown>;
  expect(await ingest(t.channel,t.auth,t.payload,t.receipt)).toEqual({status:'accepted',sourceEventId:t.receipt.sourceEventId,durablyAccepted:true});
  expect((await db.transact(t.org,tx=>tx.query('SELECT count(*)::int AS n FROM messaging_messages WHERE channel_id=$1',[t.channel]))).rows[0].n).toBe(1);
});
it.each([false,true])('deduplicates concurrent and restarted deliveries without duplicate effects (outgoing=%s)',async fromMe=>{
  const t=await fixture();t.payload.data.key.fromMe=fromMe;
  const replies=await Promise.all(Array.from({length:6},()=>t.service().ingest(t.channel,t.auth,t.payload,t.receipt)));
  expect(replies.filter(r=>r?.status==='accepted')).toHaveLength(1);
  expect(replies.filter(r=>r?.status==='duplicate')).toHaveLength(5);
  const counts=await db.transact(t.org,async tx=>({messages:(await tx.query('SELECT count(*)::int AS n FROM messaging_messages WHERE channel_id=$1',[t.channel])).rows[0].n,
    receipts:(await tx.query('SELECT count(*)::int AS n FROM qr_origin_receipts WHERE channel_id=$1',[t.channel])).rows[0].n}));
  expect(counts).toEqual({messages:1,receipts:1});
});
it('serializes distinct outbound receipts on a channel without lock upgrades',async()=>{
  const t=await fixture();t.payload.data.key.fromMe=true;
  const replies=await Promise.all(Array.from({length:4},()=>t.service().ingest(t.channel,t.auth,t.payload,{...t.receipt,sourceEventId:randomUUID()})));
  expect(replies.every(r=>r?.durablyAccepted)).toBe(true);
  expect((await db.transact(t.org,tx=>tx.query('SELECT count(*)::int AS n FROM messaging_messages WHERE channel_id=$1',[t.channel]))).rows[0].n).toBe(1);
});
it('rejects reused IDs with different content instead of silently acknowledging it',async()=>{
  const t=await fixture();await t.service().ingest(t.channel,t.auth,t.payload,t.receipt);
  const changed={...t.payload,data:{...t.payload.data,message:{conversation:'Conflicting content'}}};
  await expect(t.service().ingest(t.channel,t.auth,changed,t.receipt)).rejects.toMatchObject({code:'ORIGIN_EVENT_CONFLICT',status:409});
});
it.each([false,true])('does not ACK conflicting provider facts under a new receipt (outgoing=%s)',async fromMe=>{
  const t=await fixture();t.payload.data.key.fromMe=fromMe;
  await t.service().ingest(t.channel,t.auth,t.payload,t.receipt);
  const changed={...t.payload,data:{...t.payload.data,message:{conversation:'Different fact, same provider ID'}}};
  await expect(t.service().ingest(t.channel,t.auth,changed,{...t.receipt,sourceEventId:randomUUID()}))
    .rejects.toMatchObject({code:'ORIGIN_EVENT_CONFLICT',status:409});
  expect((await db.transact(t.org,tx=>tx.query('SELECT count(*)::int AS n FROM qr_origin_receipts WHERE channel_id=$1',[t.channel]))).rows[0].n).toBe(1);
});
it.each([false,true])('permits identical provider facts with different receipts without duplicating effects (outgoing=%s)',async fromMe=>{
  const t=await fixture();t.payload.data.key.fromMe=fromMe;
  await t.service().ingest(t.channel,t.auth,t.payload,t.receipt);
  expect(await t.service().ingest(t.channel,t.auth,t.payload,{...t.receipt,sourceEventId:randomUUID()})).toMatchObject({durablyAccepted:true});
  expect((await db.transact(t.org,tx=>tx.query('SELECT count(*)::int AS n FROM messaging_messages WHERE channel_id=$1',[t.channel]))).rows[0].n).toBe(1);
});
it('rolls back the receipt and effects on a real deferred COMMIT failure, then permits safe retry',async()=>{
  const t=await fixture();
  await db.database.pool.query(`CREATE FUNCTION origin_test_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic COMMIT failure'; END $$;
    CREATE CONSTRAINT TRIGGER origin_test_commit_failure AFTER INSERT ON qr_origin_receipts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION origin_test_commit_failure()`);
  try{await expect(t.service().ingest(t.channel,t.auth,t.payload,t.receipt)).rejects.toThrow('synthetic COMMIT failure');}
  finally{await db.database.pool.query('DROP TRIGGER origin_test_commit_failure ON qr_origin_receipts; DROP FUNCTION origin_test_commit_failure()');}
  const counts=await db.transact(t.org,async tx=>({messages:(await tx.query('SELECT count(*)::int AS n FROM messaging_messages WHERE channel_id=$1',[t.channel])).rows[0].n,
    receipts:(await tx.query('SELECT count(*)::int AS n FROM qr_origin_receipts WHERE channel_id=$1',[t.channel])).rows[0].n}));
  expect(counts).toEqual({messages:0,receipts:0});
  expect(await t.service().ingest(t.channel,t.auth,t.payload,t.receipt)).toMatchObject({status:'accepted',durablyAccepted:true});
});
it('forces synchronous commit when the caller defaults to asynchronous commit',async()=>{
  const t=await fixture();
  await db.database.pool.query(`CREATE FUNCTION origin_test_sync_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF current_setting('synchronous_commit')<>'on' THEN RAISE EXCEPTION 'async receipt prohibited'; END IF; RETURN NEW; END $$;
    CREATE CONSTRAINT TRIGGER origin_test_sync_commit AFTER INSERT ON qr_origin_receipts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION origin_test_sync_commit()`);
  try{
    const asynchronous:typeof db.transact=(org,work)=>db.transact(org,async tx=>{await tx.query('SET LOCAL synchronous_commit=off');return work(tx);});
    expect(await t.service(asynchronous).ingest(t.channel,t.auth,t.payload,t.receipt)).toMatchObject({durablyAccepted:true});
  }finally{await db.database.pool.query('DROP TRIGGER origin_test_sync_commit ON qr_origin_receipts; DROP FUNCTION origin_test_sync_commit()');}
});
it('rejects unauthenticated or unsupported facts without recording any receipt',async()=>{
  const t=await fixture();
  await expect(t.service().ingest(t.channel,'Bearer wrong',t.payload,t.receipt)).rejects.toMatchObject({code:'QR_WEBHOOK_UNAUTHORIZED'});
  const ignored={...t.payload,data:{...t.payload.data,message:{reactionMessage:{text:'ignored'}}}};
  await expect(t.service().ingest(t.channel,t.auth,ignored,t.receipt)).rejects.toMatchObject({code:'ORIGIN_EVENT_UNSUPPORTED'});
  expect((await db.transact(t.org,tx=>tx.query('SELECT count(*)::int AS n FROM qr_origin_receipts WHERE channel_id=$1',[t.channel]))).rows[0].n).toBe(0);
});
it('isolates identical source IDs between tenants and forbids runtime receipt mutation',async()=>{
  const a=await fixture(),b=await fixture();
  await a.service().ingest(a.channel,a.auth,a.payload,a.receipt);
  await b.service().ingest(b.channel,b.auth,b.payload,{...b.receipt,sourceEventId:a.receipt.sourceEventId});
  expect((await db.transact(b.org,tx=>tx.query('SELECT count(*)::int AS n FROM qr_origin_receipts WHERE organization_id=$1',[a.org]))).rows[0].n).toBe(0);
  await expect(db.transact(a.org,tx=>tx.query('UPDATE qr_origin_receipts SET content_hash=$1',['0'.repeat(64)]))).rejects.toMatchObject({code:'42501'});
  await expect(db.transact(a.org,tx=>tx.query('DELETE FROM qr_origin_receipts'))).rejects.toMatchObject({code:'42501'});
});
it('preserves the legacy webhook return and does not require an origin receipt',async()=>{
  const t=await fixture();expect(await t.service().ingest(t.channel,t.auth,t.payload)).toBeUndefined();
  expect((await db.transact(t.org,tx=>tx.query('SELECT count(*)::int AS n FROM qr_origin_receipts WHERE channel_id=$1',[t.channel]))).rows[0].n).toBe(0);
});
it('fails readiness when the origin receipt is absent from the lifecycle purge catalogue',async()=>{
  const client=await db.database.pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("DELETE FROM lifecycle_purge_catalogue WHERE table_name='qr_origin_receipts'");
    await client.query('SET LOCAL ROLE jrc_app');
    expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(false);
  }finally{await client.query('ROLLBACK');client.release();}
});
