import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {chatwootEnvironment,createChatwootService,type ChatwootOptions} from '../../src/modules/integrations/chatwoot-service.js';
import {createChatwootWorker} from '../../src/modules/integrations/chatwoot-worker.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60_000);
afterAll(async()=>{await db?.dispose();});
async function fixture(input:{lostAck?:boolean;pending?:boolean;unavailable?:boolean;legacy?:boolean;mutate?:string;expireAfterPost?:boolean;rejectOnce?:boolean}={}){
 const t=await seedAttendanceTenant(db.database),instance=randomUUID(),calls:string[]=[],nativeBodies:Record<string,unknown>[]=[];
 const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0].provider_account_id;
 await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1",[provider]);
 await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1::uuid,$2,$3,'Synthetic native',$1::text,'CONNECTED')",[instance,t.org,provider]);
 await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1",[t.channel,instance]);
 await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
  VALUES($1,$2,$3,41,'synthetic-native-source',51)`,[t.org,t.integration,t.conversation]);
 let stored:Record<string,unknown>|undefined;
 const options:ChatwootOptions={baseUrl:`https://${t.org}.example.test`,publicOrigin:'https://broker.example.test',
  encryptionKey:Buffer.alloc(32,6).toString('base64'),transact:db.transact,resolveIntegration:async id=>id===t.integration?t.org:undefined,
  async fetch(url,init){
   const path=new URL(String(url)).pathname;calls.push(path);const body=init?.body===undefined?{}:JSON.parse(String(init.body));
   if(path.endsWith('/contacts/search'))return Response.json({payload:[]});
   if(path.endsWith('/contacts'))return Response.json({payload:{contact:{id:41}}});
   if(path.endsWith('/contact_inboxes'))return Response.json({source_id:'synthetic-native-source'});
   if(path.endsWith('/conversations'))return Response.json({id:51});
   if(path.endsWith('/capability'))return Response.json({...body,account_id:7,inbox_id:9,supports_text:true,supports_media:true,max_media_bytes:16*1024*1024});
   if(path.includes('/live-ingress/v1/messages')){
    nativeBodies.push(body);
    if(input.rejectOnce){input.rejectOnce=false;return new Response('',{status:429});}
    stored={protocol:body.protocol,organization_id:body.organization_id,integration_id:body.integration_id,instance_id:body.instance_id,
     destination_revision:body.destination_revision,broker_message_id:body.broker_message_id,conversation_id:body.conversation_id,
     request_hash:body.request_hash,account_id:7,inbox_id:9,message_id:input.pending?null:901,receipt_id:randomUUID(),state:input.pending?'MEDIA_PENDING':'PERSISTED'};
    if(input.expireAfterPost)await db.database.pool.query("UPDATE integration_jobs SET lease_expires_at=now()-interval '1 second' WHERE organization_id=$1 AND status='RUNNING'",[t.org]);
    if(input.lostAck)throw Error('Synthetic response lost after COMMIT');
    return Response.json(stored);
   }
   if(path.includes('/live-ingress/v1/receipts/')){
    if(input.mutate)await db.database.pool.query(input.mutate,[t.org]);
    if(input.unavailable)return new Response('',{status:503});
    if(!stored)return new Response('',{status:404});
    return Response.json(stored);
   }
   if(path.endsWith('/conversations/51/messages')){
    if(input.lostAck)throw Error('Generic outcome must remain unknown');
    return Response.json({id:902});
   }
   throw Error('Unexpected synthetic endpoint');
  }};
 const vault=chatwootEnvironment(options).vault;
 await db.database.pool.query('UPDATE chatwoot_accounts SET encrypted_token=$2 WHERE organization_id=$1',[t.org,vault.encrypt(`${t.org}:chatwoot-account`,'synthetic')]);
 const message=(await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
  VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"Synthetic received live"}','DELIVERED') RETURNING id`,[t.org,t.channel,t.conversation])).rows[0].id;
 const job=(await db.database.pool.query('SELECT id FROM integration_jobs WHERE organization_id=$1 AND message_id=$2',[t.org,message])).rows[0].id;
 if(input.legacy)await db.database.pool.query("UPDATE integration_jobs SET payload=payload||'{\"operation\":\"SEND_MESSAGE\"}'::jsonb WHERE id=$1",[job]);
 const read=async()=>(await db.database.pool.query('SELECT status,payload,last_error FROM integration_jobs WHERE id=$1',[job])).rows[0];
 return{...t,instance,message,job,calls,nativeBodies,options,read,stored:()=>stored,complete:()=>{
  input.pending=false;input.unavailable=false;if(stored){stored.state='PERSISTED';stored.message_id=901;}
 }};
}
it('uses a bound native receipt for an individual mirror and durably records the selected protocol',async()=>{
 const t=await fixture();await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'SUCCEEDED',payload:{mirrorProtocol:'jrc-live-ingress/1',remoteMessageId:901,
  liveIngressProof:{organization_id:t.org,integration_id:t.integration,instance_id:t.instance,broker_message_id:t.message,account_id:7,inbox_id:9}}});
 expect(t.calls.filter(path=>path.endsWith('/live-ingress/v1/messages'))).toHaveLength(1);
 expect((await db.database.pool.query('SELECT state,remote_message_id FROM chatwoot_mirror_attempts WHERE job_id=$1',[t.job])).rows)
  .toEqual([{state:'CONFIRMED',remote_message_id:'901'}]);
});
it('uses the canonical source clock rather than mirror dispatch time',async()=>{
 const t=await fixture();
 await db.database.pool.query("UPDATE messaging_messages SET created_at='2026-01-02T03:04:05.987Z' WHERE id=$1",[t.message]);
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(t.nativeBodies).toHaveLength(1);expect(t.nativeBodies[0]).toMatchObject({occurred_at:1_767_323_045});
 expect(await t.read()).toMatchObject({status:'SUCCEEDED',payload:{liveIngressProof:{occurred_at:1_767_323_045}}});
});
it('does not bootstrap or send another native request when its original conversation map was removed',async()=>{
 const t=await fixture({rejectOnce:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'PENDING'});
 const before=t.calls.length;
 await db.database.pool.query('DELETE FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2',[t.org,t.integration]);
 await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[t.job]);
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(t.calls).toHaveLength(before);expect(await t.read()).not.toMatchObject({status:'SUCCEEDED'});
 expect(t.nativeBodies).toHaveLength(1);
});
it('settles a lost native ACK by receipt lookup and never emits another message POST',async()=>{
 const t=await fixture({lostAck:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'SUCCEEDED',payload:{remoteMessageId:901}});
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
 expect(t.calls.filter(path=>path.includes('/receipts/'))).toHaveLength(1);
});
it('does not perform a receipt read after its dispatch lease expires during the message POST',async()=>{
 const t=await fixture({expireAfterPost:true,lostAck:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
 expect(t.calls.filter(path=>path.includes('/receipts/'))).toHaveLength(0);
});
it('retries a definitely rejected native request with the same hash, preserving uncertain barriers',async()=>{
 const t=await fixture({rejectOnce:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'PENDING',payload:{mirrorProtocol:'jrc-live-ingress/1'}});
 const first=await t.read();
 await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[t.job]);
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'SUCCEEDED',payload:{liveIngressProof:{request_hash:first.payload.liveIngressProof.request_hash}}});
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(2);
 expect((await db.database.pool.query('SELECT state FROM chatwoot_mirror_attempts WHERE job_id=$1 ORDER BY created_at,id',[t.job])).rows)
  .toEqual([{state:'REJECTED'},{state:'CONFIRMED'}]);
});
it.each(['pending','unavailable'] as const)('retains native %s uncertainty and can reconcile only from persisted immutable proof',async reason=>{
 const t=await fixture({lostAck:reason==='unavailable',pending:reason==='pending',unavailable:reason==='unavailable'});
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN',payload:{mirrorProtocol:'jrc-live-ingress/1'}});
 const before=await t.read();
 await expect(createChatwootService(t.options).reconcileJob(t.org,t.job,'Synthetic receipt review')).rejects.toThrow();
 expect(await t.read()).toEqual(before);
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
});
it('keeps an old generic mirror generic when native capability is introduced later',async()=>{
 const t=await fixture({legacy:true,lostAck:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN',payload:{mirrorProtocol:'GENERIC'}});
 expect(t.calls.some(path=>path.includes('/live-ingress/'))).toBe(false);
});
it('does not erase a legacy generic protocol decision when bootstrap records a new phase',async()=>{
 const t=await fixture({legacy:true,lostAck:true});
 await db.database.pool.query('DELETE FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2',[t.org,t.integration]);
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN',payload:{mirrorProtocol:'GENERIC'}});
 expect(t.calls.some(path=>path.includes('/live-ingress/'))).toBe(false);
 expect(t.calls.filter(path=>path.endsWith('/conversations/51/messages'))).toHaveLength(1);
});
it('reconciles a crashed native operation from its immutable receipt without replaying POST',async()=>{
 const t=await fixture({lostAck:true,unavailable:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});t.complete();
 const postCount=t.calls.filter(path=>path.endsWith('/messages')).length;
 await expect(createChatwootService(t.options).reconcileJob(t.org,t.job,'Synthetic durable recovery')).resolves.toEqual({ok:true});
 expect(await t.read()).toMatchObject({status:'PENDING',payload:{remoteMessageId:901}});
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'SUCCEEDED'});
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(postCount);
 expect((await db.database.pool.query('SELECT state,remote_message_id FROM chatwoot_mirror_attempts WHERE job_id=$1',[t.job])).rows)
  .toEqual([{state:'CONFIRMED',remote_message_id:'901'}]);
});
it('automatically finishes a new native UNKNOWN only after the immutable custody receipt becomes persisted',async()=>{
 const t=await fixture({pending:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});t.complete();
 const posts=t.calls.filter(path=>path.endsWith('/messages')).length;
 await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[t.job]);
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'SUCCEEDED'});
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(posts);
 expect((await db.database.pool.query("SELECT action,reason FROM integration_audit WHERE organization_id=$1 AND resource_id=$2",[t.org,t.job])).rows)
  .toEqual([{action:'JOB_RECONCILED',reason:'NATIVE_PERSISTENCE_RECEIPT_RECOVERED'}]);
});
it('automatic receipt inspection does not release pending custody or generic UNKNOWN records',async()=>{
 const native=await fixture({pending:true});await createChatwootWorker(native.options).runOnce(native.org);
 await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[native.job]);
 const posts=native.calls.filter(path=>path.endsWith('/messages')).length;
 await createChatwootWorker(native.options).runOnce(native.org);
 expect(await native.read()).toMatchObject({status:'UNKNOWN'});
 expect(native.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(posts);
 const legacy=await fixture({legacy:true,lostAck:true});await createChatwootWorker(legacy.options).runOnce(legacy.org);
 await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[legacy.job]);
 const before=await legacy.read(),calls=legacy.calls.length;
 await createChatwootWorker(legacy.options).runOnce(legacy.org);
 expect(await legacy.read()).toEqual(before);expect(legacy.calls).toHaveLength(calls);
});
it('does not accept a different receipt identity after observing pending media custody',async()=>{
 const t=await fixture({pending:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});t.complete();
 t.stored()!.receipt_id=randomUUID();const before=await t.read();
 await expect(createChatwootService(t.options).reconcileJob(t.org,t.job,'Synthetic replaced receipt')).rejects.toThrow();
 expect(await t.read()).toEqual(before);
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
});
it('takes instance before channel locks so lifecycle cannot deadlock against a mirror',async()=>{
 const t=await fixture(),lifecycle=await db.database.pool.connect();let running:Promise<unknown>|undefined;
 let blocked=false,channelLockCode:string|undefined;
 try{
  await lifecycle.query('BEGIN');
  await lifecycle.query('SELECT id FROM instances WHERE id=$1 FOR UPDATE',[t.instance]);
  const lifecyclePid=(await lifecycle.query('SELECT pg_backend_pid() AS id')).rows[0].id;
  running=createChatwootWorker(t.options).runOnce(t.org);
  for(let n=0;n<100&&!blocked;n++){
   blocked=Boolean((await db.database.pool.query(`SELECT 1 FROM pg_locks waiter JOIN pg_locks holder
    ON holder.locktype=waiter.locktype AND holder.transactionid=waiter.transactionid
    WHERE holder.pid=$1 AND holder.granted AND NOT waiter.granted AND waiter.pid<>holder.pid LIMIT 1`,[lifecyclePid])).rowCount);
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,20));
  }
  try{await lifecycle.query('SELECT id FROM messaging_channels WHERE id=$1 FOR NO KEY UPDATE NOWAIT',[t.channel]);}
  catch(error){channelLockCode=(error as {code?:string}).code;}
 }finally{await lifecycle.query('ROLLBACK');lifecycle.release();await running;}
 expect(blocked).toBe(true);expect(channelLockCode).toBeUndefined();
 expect(await t.read()).toMatchObject({status:'SUCCEEDED'});
});
it.each([
 ['credential','UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1'],
 ['destination','UPDATE chatwoot_destinations SET revision=revision+1 WHERE organization_id=$1'],
 ['inbox','UPDATE chatwoot_connections SET inbox_id=10 WHERE organization_id=$1'],
])('preserves uncertainty after %s changes during the receipt read',async(_kind,mutate)=>{
 const t=await fixture({lostAck:true,mutate});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});
 const attempts=(await db.database.pool.query('SELECT state,remote_message_id FROM chatwoot_mirror_attempts WHERE job_id=$1',[t.job])).rows;
 expect(attempts).toHaveLength(1);expect(attempts[0].remote_message_id).toBeNull();
 expect(['DISPATCHED','UNKNOWN']).toContain(attempts[0].state);
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
});
