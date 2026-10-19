import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {ensureQrChannel} from '../../src/modules/messaging/qr-service.js';
import {persistQrHistoryPage} from '../../src/modules/history-import/qr-writer.js';
import {createChatwootService,type ChatwootOptions} from '../../src/modules/integrations/chatwoot-service.js';
import {createChatwootWorker} from '../../src/modules/integrations/chatwoot-worker.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();});afterAll(async()=>{await db?.dispose();});
async function fixture(supported=true){
 const tenant=await seedAttendanceTenant(db.database,false);
 const channel=await db.transact(tenant.org,async tx=>{
  const provider=(await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','History') RETURNING id",[tenant.org])).rows[0].id;
  const instance=(await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'History',$3,'CONNECTED') RETURNING id",[tenant.org,provider,randomUUID()])).rows[0].id;
  return(await ensureQrChannel(tx,tenant.org,instance)).id;
 });
 const calls:Array<{path:string;method:string;body:Record<string,unknown>}>=[],remote=new Map<string,number>();let integration='',loseResponse=false,loseBootstrap=false,raceLiveMap=false;
 const options:ChatwootOptions={baseUrl:`https://${tenant.org}.example.test`,publicOrigin:'https://broker.test',encryptionKey:Buffer.alloc(32,7).toString('base64'),
  transact:db.transact,resolveIntegration:async()=>tenant.org,async fetch(input,init){
   const path=new URL(String(input)).pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):{};calls.push({path,method,body});
   if(path==='/api/v1/profile')return Response.json({accounts:[{id:1,role:'administrator'}]});
   if(path.endsWith('/inboxes')&&method==='POST')return Response.json({id:31,name:'History',channel_type:'Channel::Api',secret:'synthetic-callback',webhook_url:body.channel.webhook_url});
   if(path.endsWith('/jrc_history_import/inboxes/31'))return supported?Response.json({protocol:'jrc-history-import/1',account_id:1,inbox_id:31,organization_id:tenant.org,integration_id:integration,supports_text:true,supports_silent_bootstrap:true}):new Response('{}',{status:404});
   if(path.endsWith('/jrc_history_import/inboxes/31/bootstrap')){
    if(loseBootstrap){loseBootstrap=false;throw new Error('synthetic disconnect after silent bootstrap commit');}
    if(raceLiveMap)await db.transact(tenant.org,tx=>tx.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
      SELECT $1,$2,id,41,'synthetic-source',77 FROM messaging_conversations WHERE organization_id=$1 AND channel_id=$3
      ON CONFLICT(organization_id,integration_id,conversation_id) DO NOTHING`,[tenant.org,integration,channel]));
    return Response.json({protocol:'jrc-history-import/1',account_id:1,inbox_id:31,organization_id:tenant.org,integration_id:integration,
      contact_id:41,source_id:'synthetic-source',conversation_id:51,broker_contact_id:body.broker_contact_id,broker_conversation_id:body.broker_conversation_id});
   }
   if(path.endsWith('/inboxes/31'))return Response.json({id:31,name:'History',channel_type:'Channel::Api',greeting_enabled:false,enable_auto_assignment:false});
   if(path.endsWith('/inboxes/31/agent_bot'))return Response.json({});
   if(path.endsWith('/contacts/search'))return Response.json({payload:[]});
   if(path.endsWith('/contacts'))return Response.json({payload:{contact:{id:41}}});
   if(path.endsWith('/contact_inboxes'))return Response.json({source_id:'synthetic-source'});
   if(path.endsWith('/conversations')&&method==='POST')return Response.json({id:51});
   if(path.endsWith('/jrc_history_import')&&method==='POST'){
    if(!remote.has(body.broker_message_id))remote.set(body.broker_message_id,remote.size+61);
    if(loseResponse){loseResponse=false;throw new Error('synthetic disconnect after historical commit');}
    return Response.json({protocol:'jrc-history-import/1',account_id:1,inbox_id:31,conversation_id:Number(path.split('/conversations/')[1]?.split('/')[0]),organization_id:tenant.org,integration_id:integration,broker_message_id:body.broker_message_id,id:remote.get(body.broker_message_id)});
   }
   if(path.endsWith('/messages')&&method==='POST')return Response.json({id:91});
   if(method==='PATCH')return Response.json({});
   throw new Error('Unexpected synthetic route '+path);
  }};
 const service=createChatwootService(options);await service.bindAccount(tenant.org,{accountId:1,token:'synthetic-only'});await service.connect(tenant.org,{channelId:channel,name:'History'});
 integration=(await db.transact(tenant.org,tx=>tx.query('SELECT id FROM chatwoot_connections WHERE channel_id=$1',[channel]))).rows[0].id;
 const record=(id:string,fromMe=false)=>({ordinal:0,providerMessageId:id,remoteJid:'15550000001@s.whatsapp.net',fromMe,messageTimestamp:Math.floor(Date.now()/1000)-86400,text:'Archived synthetic text',displayName:'Synthetic'});
 const write=(id:string,fromMe=false)=>db.transact(tenant.org,tx=>persistQrHistoryPage(tx,tenant.org,channel,[record(id,fromMe)]));
 const jobs=()=>db.transact(tenant.org,tx=>tx.query('SELECT status,last_error,payload FROM integration_jobs WHERE integration_id=$1 ORDER BY created_at,id',[integration])).then(result=>result.rows);
 return{...tenant,channel,record,write,remote,calls,options,jobs,worker:()=>createChatwootWorker(options),loseNextResponse:()=>{loseResponse=true;},loseNextBootstrap:()=>{loseBootstrap=true;},raceLiveMapping:()=>{raceLiveMap=true;}};
}
describe('historical central import without live message side effects',()=>{
 it('keeps new historical work out of the pending lane consumed by older deployed workers',async()=>{
  const f=await fixture();await f.write('rollback-fence');
  const legacy=(await db.transact(f.org,tx=>tx.query("SELECT id FROM integration_jobs WHERE organization_id=$1 AND status='PENDING'",[f.org]))).rows;
  expect(legacy).toEqual([]);expect(await f.jobs()).toMatchObject([{status:'HISTORY_PENDING'}]);
 });
 it('uses only the explicit history endpoint for both directions and preserves original timestamps',async()=>{
  const f=await fixture();await f.write('in');await f.write('out',true);f.calls.length=0;
  const timestamps=(await db.transact(f.org,tx=>tx.query('SELECT created_at FROM messaging_messages WHERE channel_id=$1 ORDER BY sequence_number',[f.channel]))).rows.map(row=>Math.floor(row.created_at.getTime()/1000));
  await f.worker().runOnce(f.org);await f.worker().runOnce(f.org);
  const imports=f.calls.filter(call=>call.path.endsWith('/jrc_history_import'));
  expect(imports,JSON.stringify({jobs:await f.jobs(),calls:f.calls.map(call=>[call.method,call.path])})).toHaveLength(2);expect(imports.map(call=>call.body.direction)).toEqual(['incoming','outgoing']);
  expect(imports.map(call=>call.body.occurred_at)).toEqual(timestamps);
  expect(f.calls.filter(call=>call.path.endsWith('/messages'))).toEqual([]);
  expect(f.calls.filter(call=>call.method==='POST'&&/\/(contacts|contact_inboxes|conversations)$/.test(call.path))).toEqual([]);
  expect(f.remote.size).toBe(2);expect((await f.jobs()).map(job=>job.status)).toEqual(['SUCCEEDED','SUCCEEDED']);
  expect((await db.transact(f.org,tx=>tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[f.org]))).rows).toEqual([]);
 });
 it('never falls back to live POSTs when the central lacks the historical capability',async()=>{
  const f=await fixture(false);await f.write('unsupported');f.calls.length=0;await f.worker().runOnce(f.org);
  expect(f.calls.filter(call=>call.method!=='GET')).toEqual([]);
  expect(await f.jobs()).toMatchObject([{status:'FAILED',last_error:'CHATWOOT_HISTORY_UNSUPPORTED'}]);
 });
 it('retries a silently committed bootstrap after response loss without using ordinary contact or conversation creation',async()=>{
  const f=await fixture();await f.write('bootstrap-retry');f.loseNextBootstrap();f.calls.length=0;await f.worker().runOnce(f.org);
  expect(await f.jobs()).toMatchObject([{status:'HISTORY_PENDING',payload:{operation:'IMPORT_HISTORY'}}]);
  await db.transact(f.org,tx=>tx.query('UPDATE integration_jobs SET available_at=now() WHERE organization_id=$1',[f.org]));
  await f.worker().runOnce(f.org);
  expect(await f.jobs()).toMatchObject([{status:'SUCCEEDED'}]);
  expect(f.calls.filter(call=>call.method==='POST'&&/\/(contacts|contact_inboxes|conversations)$/.test(call.path))).toEqual([]);
  const requests=f.calls.filter(call=>call.path.endsWith('/bootstrap')).map(call=>call.body);
  expect(requests).toHaveLength(2);expect(requests[0]).toEqual(requests[1]);expect(f.remote.size).toBe(1);
 });
 it('recovers an ambiguous historical response with the same identity without blocking the live lane',async()=>{
  const f=await fixture();await f.write('ambiguous');f.loseNextResponse();await f.worker().runOnce(f.org);
  expect((await f.jobs())[0].last_error).toBe('CHATWOOT_HISTORY_UNAVAILABLE');
  expect(await f.jobs()).toMatchObject([{status:'HISTORY_PENDING',payload:{operation:'IMPORT_HISTORY'}}]);
  await db.transact(f.org,tx=>tx.query("UPDATE integration_jobs SET available_at=now() WHERE organization_id=$1",[f.org]));
  await f.worker().runOnce(f.org);expect(f.remote.size).toBe(1);
  expect((await f.jobs()).map(job=>job.status)).toEqual(['SUCCEEDED']);
 });
 it('uses the persisted live mapping when it wins the race with silent historical bootstrap',async()=>{
  const f=await fixture();await f.write('mapping-race');f.raceLiveMapping();f.calls.length=0;
  await f.worker().runOnce(f.org);
  expect(await f.jobs()).toMatchObject([{status:'SUCCEEDED'}]);
  expect(f.calls.filter(call=>call.path.endsWith('/jrc_history_import')).map(call=>call.path)).toEqual(['/api/v1/accounts/1/conversations/77/jrc_history_import']);
 });
 it('prioritizes a new live message over the historical backlog',async()=>{
  const f=await fixture();await f.write('old');
  await db.transact(f.org,tx=>tx.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,upstream_message_id,content,state)
   SELECT $1,$2,id,'INCOMING','CONTACT','new-live','{"type":"TEXT","text":"New live text"}','DELIVERED' FROM messaging_conversations WHERE channel_id=$2`,[f.org,f.channel]));
  f.calls.length=0;await f.worker().runOnce(f.org);
  expect(f.calls.filter(call=>call.path.endsWith('/messages')).map(call=>call.body.content)).toEqual(['New live text']);
  expect(f.remote.size).toBe(0);
 });
 it('recovers an expired lease only after reaching the idempotent historical import phase',async()=>{
  const f=await fixture();await f.write('expired');
  await db.transact(f.org,tx=>tx.query(`UPDATE integration_jobs SET status='RUNNING',lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 minute',
   payload=payload||'{"operation":"IMPORT_HISTORY"}'::jsonb WHERE organization_id=$1`,[f.org]));
  await f.worker().runOnce(f.org);expect(f.remote.size).toBe(1);expect(await f.jobs()).toMatchObject([{status:'SUCCEEDED'}]);
 });
 it('updates an already mapped historical acknowledgement through the same silent protocol',async()=>{
  const f=await fixture();await f.write('status-later',true);await f.worker().runOnce(f.org);
  await db.transact(f.org,tx=>tx.query("UPDATE messaging_messages SET state='READ' WHERE channel_id=$1",[f.channel]));
  await f.worker().runOnce(f.org);
  expect(f.calls.filter(call=>call.path.endsWith('/jrc_history_import')).map(call=>call.body.status)).toEqual(['sent','read']);
  expect(f.calls.filter(call=>call.path.endsWith('/messages')||call.method==='PATCH'&&call.path.includes('/messages/'))).toEqual([]);
  expect(f.remote.size).toBe(1);
 });
});
