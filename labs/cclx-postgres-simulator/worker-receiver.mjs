import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {requireLabOnly,validateDatabaseUrl,validateMediaState,poolFor} from './state.mjs';
import {createLabS3Custody} from './s3-custody.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const sha=b=>createHash('sha256').update(b).digest('hex');
const problem=(status,code)=>Object.assign(Error(code),{status});
/** Strict local fixture adapter for actual Broker partner envelopes. Never a production endpoint. */
export async function openPartnerWorkerLabReceiver(options){
 requireLabOnly(options);validateDatabaseUrl(options.database?.connectionString,true);await validateMediaState(options.mediaState);
 const {signingSecret,brokerOrigin,apiKey,endpointId,expected:e}=options.partnerFixture??{};
 let origin;try{origin=new URL(brokerOrigin);}catch{throw Error('INVALID_WORKER_FIXTURE');}
 if(!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||
  !['http:','https:'].includes(origin.protocol)||typeof signingSecret!=='string'||signingSecret.length<16||typeof apiKey!=='string'||!apiKey.startsWith('jrc_')||!uuid.test(endpointId)||
  !e||!['00000000-0000-4000-8000-000000000900','00000000-0000-4000-8000-000000000910'].includes(e.organizationId)||
  !['channelId','messageId','mediaId'].every(k=>typeof e[k]==='string'&&uuid.test(e[k]))||!/^[a-f0-9]{64}$/.test(e.sha256)||!Number.isSafeInteger(e.byteSize)||e.byteSize<1||e.byteSize>16*1024*1024||e.mime!=='application/pdf')throw Error('INVALID_WORKER_FIXTURE');
 const fixed=Object.freeze({...e}),store=createLabS3Custody(options.s3,{labOnly:true}),pool=poolFor(options.database.connectionString);
 try{
  const marker=(await pool.query('SELECT token FROM cclx_lab_marker')).rows;
  if(marker.length!==1||marker[0].token!==options.database.token)throw Error('LAB_DATABASE_MARKER_MISMATCH');
  const settings=(await pool.query("SELECT current_setting('fsync')='on' AND current_setting('full_page_writes')='on' AS durable")).rows[0];
  if(!settings.durable)throw Error('DURABLE_POSTGRES_REQUIRED');
 }catch(error){await pool.end();throw error;}
 let closing=false,queue=Promise.resolve();
 const run=fn=>{if(closing)throw Error('LAB_RECEIVER_CLOSED');const pending=queue.then(fn);queue=pending.catch(()=>{});return pending;};
 const select=async(table,eventId)=>{
  if(!uuid.test(eventId))throw Error('INVALID_WORKER_EVENT_ID');
  const column=table==='cclx_lab_inbox'?'envelope':'receipt';
  return (await pool.query(`SELECT ${column} FROM ${table} WHERE organization_id=$1 AND event_id=$2`,[fixed.organizationId,eventId])).rows[0]?.[column]??null;
 };
 async function request(path,init={}){
  // Fixed origin and enumerated internal path only. No URL from an event is fetched.
  const response=await fetch(new URL(path,origin),{...init,redirect:'error',signal:AbortSignal.timeout(10000),headers:{'x-jrc-api-key':apiKey,...init.headers}});
  return response;
 }
 async function handle(input){
  try{
   if(input.method!=='POST'||input.path!=='/lab/cclx/events')throw problem(404,'LAB_ROUTE_ONLY');
   const raw=input.rawBody,h=input.headers??{},id=h['x-jrc-event-id'],ts=h['x-jrc-timestamp'],signature=h['x-jrc-signature'];
   if(!Buffer.isBuffer(raw)||raw.length>2*1024*1024||h['content-type']!=='application/json')throw problem(400,'INVALID_WORKER_BODY');
   if(typeof id!=='string'||!uuid.test(id)||typeof ts!=='string'||!/^\d{1,12}$/.test(ts)||Math.abs(Date.now()/1000-Number(ts))>300||typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature))throw problem(401,'AUTHENTICATION_REFUSED');
   const digest=createHmac('sha256',signingSecret).update(`${ts}.${id}.`).update(raw).digest();
   if(!timingSafeEqual(digest,Buffer.from(signature.slice(7),'hex')))throw problem(401,'AUTHENTICATION_REFUSED');
   let event;try{event=JSON.parse(raw);}catch{throw problem(400,'INVALID_WORKER_BODY');}
   const data=event?.data;
   if(event.schemaVersion!==1||event.eventId!==id||event.organizationId!==fixed.organizationId||event.type!=='message.received'||!/^\d{1,19}$/.test(event.cursor)||BigInt(event.cursor)>9223372036854775807n||!Number.isFinite(Date.parse(event.occurredAt))||
    data?.messageId!==fixed.messageId||data.channelId!==fixed.channelId||data.content?.type!=='MEDIA'||data.content.mediaId!==fixed.mediaId||data.content.fileName!=='synthetic-worker.pdf')throw problem(422,'WORKER_FIXTURE_MISMATCH');
   const prior=await select('cclx_lab_inbox',id);
   if(prior&&sha(JSON.stringify(prior))!==sha(JSON.stringify(event)))throw problem(409,'EVENT_CONTENT_CONFLICT');
   const response=await request('/v1/messaging/media/'+fixed.mediaId);
   if(response.status!==200){await response.body?.cancel();throw problem(503,'BROKER_MEDIA_UNAVAILABLE');}
   if(response.headers.get('content-type')?.split(';')[0]!==fixed.mime){await response.body?.cancel();throw problem(422,'MEDIA_MIME_MISMATCH');}
   const chunks=[];let total=0;
   for await(const part of response.body){total+=part.length;if(total>fixed.byteSize)throw problem(422,'MEDIA_SIZE_MISMATCH');chunks.push(part);}
   const bytes=Buffer.concat(chunks);
   if(total!==fixed.byteSize||sha(bytes)!==fixed.sha256||bytes.toString('ascii',0,5)!=='%PDF-')throw problem(422,'MEDIA_INTEGRITY_MISMATCH');
   const custody=await store.persist({organizationId:fixed.organizationId,eventId:id,bytes,hash:fixed.sha256});
   const candidate={...custody,organizationId:fixed.organizationId,eventId:id,hash:fixed.sha256,bytes:total,mime:fixed.mime,sourceEligibleForDeletion:false,validation:'SIGNATURE_ONLY_NO_CODEC_VALIDATION',committedAt:new Date().toISOString()};
   const client=await pool.connect();let receipt,duplicate=false;
   try{
    await client.query('BEGIN');await client.query('SET LOCAL synchronous_commit=on');
    const inserted=await client.query('INSERT INTO cclx_lab_inbox VALUES($1,$2,$3,$4,now()) ON CONFLICT DO NOTHING RETURNING event_id',[fixed.organizationId,id,sha(raw),event]);duplicate=inserted.rowCount===0;
    const existing=(await client.query('SELECT body_hash FROM cclx_lab_inbox WHERE organization_id=$1 AND event_id=$2',[fixed.organizationId,id])).rows[0];
    if(existing.body_hash!==sha(raw))throw problem(409,'EVENT_CONTENT_CONFLICT');
    await client.query('INSERT INTO cclx_lab_projections VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[fixed.organizationId,id,event.cursor]);
    const written=await client.query('INSERT INTO cclx_lab_media_receipts VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING receipt',[fixed.organizationId,id,candidate]);
    receipt=written.rows[0]?.receipt??(await client.query('SELECT receipt FROM cclx_lab_media_receipts WHERE organization_id=$1 AND event_id=$2',[fixed.organizationId,id])).rows[0].receipt;
    if(receipt.storage!=='S3'||receipt.destinationFingerprint!==custody.destinationFingerprint||receipt.hash!==fixed.sha256)throw problem(409,'MEDIA_DESTINATION_CONFLICT');
    await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
   // Attestation is sent only after physical readback plus local SQL COMMIT. Broker still returns KEEP.
   const attested=await request('/v1/media-custody/receipts',{method:'POST',headers:{'content-type':'application/json','idempotency-key':id},body:JSON.stringify({schemaVersion:1,channelId:fixed.channelId,messageId:fixed.messageId,mediaId:fixed.mediaId,endpointId,destinationVersion:1,clientReceiptId:id,byteSize:total,sha256:fixed.sha256,storageObjectId:receipt.objectName,attestation:'DURABLY_STORED'})});
   if(attested.status!==201){await attested.body?.cancel();throw problem(503,'BROKER_ATTESTATION_UNAVAILABLE');}await attested.body?.cancel();
   return {status:202,body:{status:'accepted',duplicate,eventId:id,custody:receipt}};
  }catch(error){return {status:error.status??500,body:{code:error.status?error.message:'LAB_INTERNAL_ERROR'}};}
 }
 return {handle:input=>run(()=>handle(input)),readEvent:id=>run(()=>select('cclx_lab_inbox',id)),readMediaReceipt:id=>run(()=>select('cclx_lab_media_receipts',id)),
  stats:()=>run(async()=>(await pool.query(`SELECT (SELECT count(*)::int FROM cclx_lab_inbox) inbox,(SELECT count(*)::int FROM cclx_lab_projections) projections,(SELECT count(*)::int FROM cclx_lab_media_receipts) "mediaReceipts"`)).rows[0]),
  close:async()=>{closing=true;await queue;await pool.end();}};
}
