import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { open, lstat, readFile, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { requireLabOnly, validateDatabaseUrl, validateMediaState, poolFor } from './state.mjs';

export const LAB_ORGANIZATIONS=Object.freeze(['00000000-0000-4000-8000-000000000900','00000000-0000-4000-8000-000000000910']);
export const LAB_SECRET='synthetic-cclx-fixture-key-never-production';
const EVENT_ID=/^00000000-0000-4000-8000-\d{12}$/,MAX_BODY_BYTES=2*1024*1024,REPLAY_WINDOW_SECONDS=300;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(status,code)=>Object.assign(Error(code),{status});
function identity(eventId,organizationId){
  if(!EVENT_ID.test(eventId)||typeof eventId!=='string')throw fail(400,'SYNTHETIC_EVENT_ID_REQUIRED');
  if(!LAB_ORGANIZATIONS.includes(organizationId))throw fail(403,'TENANT_REFUSED');
}
function authenticate(request,now){
  const {rawBody:raw,headers={}}=request,id=headers['x-jrc-event-id'],timestamp=headers['x-jrc-timestamp'],signature=headers['x-jrc-signature'];
  if(!Buffer.isBuffer(raw))throw fail(400,'RAW_BYTES_REQUIRED');
  if(raw.length>MAX_BODY_BYTES)throw fail(413,'BODY_LIMIT');
  if(typeof id!=='string'||!EVENT_ID.test(id)||typeof timestamp!=='string'||!/^\d{1,12}$/.test(timestamp)||
    Math.abs(Math.floor(now/1000)-Number(timestamp))>REPLAY_WINDOW_SECONDS||typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature))throw fail(401,'AUTHENTICATION_REFUSED');
  const expected=createHmac('sha256',LAB_SECRET).update(`${timestamp}.${id}.`).update(raw).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex')))throw fail(401,'AUTHENTICATION_REFUSED');
  let event;try{event=JSON.parse(raw.toString('utf8'));}catch{throw fail(400,'INVALID_JSON');}
  identity(id,event?.organizationId);
  if(event.eventId!==id)throw fail(400,'EVENT_ID_MISMATCH');
  const occurred=event.occurredAt,validDate=typeof occurred==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(occurred)&&Number.isFinite(Date.parse(occurred))&&new Date(occurred).toISOString()===occurred;
  if(event.schemaVersion!==1||event.type!=='message.received'||!validDate||typeof event.cursor!=='string'||!/^(0|[1-9]\d{0,18})$/.test(event.cursor)||BigInt(event.cursor)>9223372036854775807n||
    Object.keys(event).some(k=>!['schemaVersion','eventId','cursor','organizationId','type','occurredAt','data'].includes(k))||
    event.data?.labFixture!==true||!Number.isSafeInteger(event.data.sequence)||event.data.sequence<0||Object.keys(event.data).some(k=>!['labFixture','sequence'].includes(k)))throw fail(400,'SYNTHETIC_FIXTURE_REQUIRED');
  return event;
}
function sniffMime(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE')return 'audio/wav';
  if(bytes.toString('ascii',4,8)==='ftyp')return 'video/mp4';
  if(bytes.toString('ascii',0,5)==='%PDF-')return 'application/pdf';
  return null;
}
async function verifyFile(path,expectedHash){
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||hash(await readFile(path))!==expectedHash)throw Error('STORED_MEDIA_CORRUPTED');
}
async function syncDirectory(directory){
  let handle;try{handle=await open(directory,'r');await handle.sync();return 'SYNCED';}
  catch(error){if(!['EPERM','EISDIR','EINVAL','ENOTSUP','EACCES'].includes(error.code))throw error;return 'UNAVAILABLE_ON_PLATFORM';}
  finally{await handle?.close();}
}

/** No listener or external transport: injected local lab request only, separate from Broker routes. */
export async function openLabReceiver(options={}){
  requireLabOnly(options);
  if(options.partnerFixture)return (await import('./worker-receiver.mjs')).openPartnerWorkerLabReceiver(options);
  const directory=await validateMediaState(options.mediaState),url=options.database?.connectionString;
  validateDatabaseUrl(url,true);
  const s3=options.s3?(await import('./s3-custody.mjs')).createLabS3Custody(options.s3,{labOnly:true}):null;
  const pool=poolFor(url),faults=[...(options.faults??[])],now=options.now??(()=>Date.now());
  try{
    if(faults.some(f=>!['afterInboxInsert','lostAckAfterCommit'].includes(f)))throw Error('INVALID_FAULT');
    const durable=(await pool.query("SELECT current_setting('fsync')='on' AND current_setting('full_page_writes')='on' AS durable")).rows[0];
    if(!durable?.durable)throw Error('DURABLE_POSTGRES_REQUIRED');
    const rows=(await pool.query('SELECT token FROM cclx_lab_marker')).rows;
    if(rows.length!==1||rows[0].token!==options.database.token)throw Error('LAB_DATABASE_MARKER_MISMATCH');
  }catch(error){await pool.end();throw error;}
  let closing=false,closePromise,mediaQueue=Promise.resolve();const pending=new Set();
  const run=work=>{
    if(closing)throw Error('LAB_RECEIVER_CLOSED');
    const promise=Promise.resolve().then(work);pending.add(promise);
    promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;
  };
  const readEvent=async(eventId,organizationId=LAB_ORGANIZATIONS[0])=>{identity(eventId,organizationId);
    return (await pool.query('SELECT envelope FROM cclx_lab_inbox WHERE organization_id=$1 AND event_id=$2',[organizationId,eventId])).rows[0]?.envelope??null;};
  const readMediaReceipt=async(eventId,organizationId=LAB_ORGANIZATIONS[0])=>{identity(eventId,organizationId);
    return (await pool.query('SELECT receipt FROM cclx_lab_media_receipts WHERE organization_id=$1 AND event_id=$2',[organizationId,eventId])).rows[0]?.receipt??null;};
  async function handle(request){
    try{
      if(request.method!=='POST'||request.path!=='/lab/cclx/events')throw fail(404,'LAB_ROUTE_ONLY');
      if(request.headers?.['content-type']!=='application/json')throw fail(415,'JSON_REQUIRED');
      const event=authenticate(request,now()),bodyHash=hash(request.rawBody),fault=faults.shift(),client=await pool.connect();
      let duplicate=false;
      try{
        await client.query('BEGIN');
        await client.query('SET LOCAL synchronous_commit=on');
        const inserted=await client.query(`INSERT INTO cclx_lab_inbox(organization_id,event_id,body_hash,envelope) VALUES($1,$2,$3,$4)
          ON CONFLICT(organization_id,event_id) DO NOTHING RETURNING event_id`,[event.organizationId,event.eventId,bodyHash,event]);
        if(inserted.rowCount){
          if(fault==='afterInboxInsert')throw fail(500,'SYNTHETIC_ROLLBACK');
          await client.query('INSERT INTO cclx_lab_projections VALUES($1,$2,$3)',[event.organizationId,event.eventId,event.data.sequence]);
        }else{
          const existing=(await client.query('SELECT body_hash FROM cclx_lab_inbox WHERE organization_id=$1 AND event_id=$2',[event.organizationId,event.eventId])).rows[0];
          if(existing?.body_hash!==bodyHash)throw fail(409,'EVENT_CONTENT_CONFLICT');
          duplicate=true;
        }
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      if(fault==='lostAckAfterCommit')throw Error('SYNTHETIC_LOST_ACK');
      return {status:202,body:{status:'accepted',duplicate}};
    }catch(error){
      if(error.message==='SYNTHETIC_LOST_ACK')throw error;
      return {status:error.status??500,body:{code:error.status?error.message:'LAB_INTERNAL_ERROR'}};
    }
  }
  async function persistMedia(input){
    requireLabOnly({labOnly:true});
    const {eventId,organizationId,expectedHash,mime,maxBytes,chunks,fault}=input;
    identity(eventId,organizationId);
    if(Object.keys(input).some(k=>!['eventId','organizationId','expectedHash','mime','maxBytes','chunks','fault'].includes(k))||
      typeof expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(expectedHash)||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024||
      !['image/png','audio/wav','video/mp4','application/pdf'].includes(mime)||(fault!==undefined&&!['afterFileSync','afterReceiptCommit',...(s3?['afterObjectUpload','beforeReceiptCommit']:[])].includes(fault)))throw Error('INVALID_MEDIA_FIXTURE');
    if(!await readEvent(eventId,organizationId))throw Error('EVENT_NOT_PERSISTED');
    await validateMediaState(options.mediaState);
    const previous=await readMediaReceipt(eventId,organizationId);
    if(previous&&(previous.hash!==expectedHash||previous.mime!==mime))throw Error('MEDIA_CONTENT_CONFLICT');
    if(previous&&((previous.storage==='S3')!==Boolean(s3)))throw Error('MEDIA_DESTINATION_CONFLICT');
    const objectName=`media-${hash(`${organizationId}\0${eventId}`)}.bin`,finalPath=join(directory,objectName),temporary=join(directory,`media-${randomUUID()}.part`);
    let file,total=0,signature=Buffer.alloc(0);const digest=createHash('sha256');
    try{
      file=await open(temporary,'wx',0o600);
      for await(const chunk of chunks){
        if(!Buffer.isBuffer(chunk))throw Error('INVALID_MEDIA_CHUNK');
        total+=chunk.length;if(total>maxBytes)throw Error('LIMIT_EXCEEDED');
        digest.update(chunk);signature=Buffer.concat([signature,chunk.subarray(0,16-signature.length)]);
        await file.writeFile(chunk);
      }
      if(digest.digest('hex')!==expectedHash)throw Error('HASH_MISMATCH');
      if(sniffMime(signature)!==mime)throw Error('MIME_REJECTED');
      await file.sync();await file.close();file=undefined;
      let custody;
      if(s3){
        custody=await s3.persist({organizationId,eventId,bytes:await readFile(temporary),hash:expectedHash});
        if(fault==='afterObjectUpload')throw Error('SYNTHETIC_AFTER_OBJECT_UPLOAD');
        if(previous&&(previous.storage!=='S3'||previous.destinationFingerprint!==custody.destinationFingerprint))throw Error('MEDIA_DESTINATION_CONFLICT');
      }else{
        // Hard-link creation never overwrites a concurrent or previous committed object.
        try{await link(temporary,finalPath);}catch(error){if(error.code!=='EEXIST')throw error;}
        await verifyFile(finalPath,expectedHash);
        custody={directorySync:await syncDirectory(directory)};
        if(fault==='afterFileSync')throw Error('SYNTHETIC_AFTER_FILE_SYNC');
      }
      if(previous)return previous;
      const receipt={status:'COPY_PERSISTED_UNVALIDATED',ack:'ACK_COPY_PERSISTED_LAB',organizationId,eventId,objectName,bytes:total,mime,hash:expectedHash,
        committedAt:new Date(now()).toISOString(),sourceEligibleForDeletion:false,validation:'SIGNATURE_ONLY_NO_CODEC_VALIDATION',...custody};
      const client=await pool.connect();let committedReceipt;
      try{
        await client.query('BEGIN');
        await client.query('SET LOCAL synchronous_commit=on');
        const inserted=await client.query('INSERT INTO cclx_lab_media_receipts VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING receipt',[organizationId,eventId,receipt]);
        committedReceipt=inserted.rows[0]?.receipt??(await client.query('SELECT receipt FROM cclx_lab_media_receipts WHERE organization_id=$1 AND event_id=$2',[organizationId,eventId])).rows[0]?.receipt;
        if(!committedReceipt||committedReceipt.hash!==expectedHash||committedReceipt.mime!==mime)throw Error('MEDIA_CONTENT_CONFLICT');
        if((committedReceipt.storage==='S3')!==Boolean(s3))throw Error('MEDIA_DESTINATION_CONFLICT');
        if(s3&&(committedReceipt.storage!=='S3'||committedReceipt.destinationFingerprint!==custody.destinationFingerprint))throw Error('MEDIA_DESTINATION_CONFLICT');
        if(fault==='beforeReceiptCommit')throw Error('SYNTHETIC_BEFORE_RECEIPT_COMMIT');
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      if(fault==='afterReceiptCommit')throw Error('SYNTHETIC_LOST_MEDIA_ACK');
      return committedReceipt;
    }finally{
      await file?.close();
      try{await unlink(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
    }
  }
  return {handle:request=>run(()=>handle(request)),readEvent:(...args)=>run(()=>readEvent(...args)),readMediaReceipt:(...args)=>run(()=>readMediaReceipt(...args)),
    stats:()=>run(async()=>(await pool.query(`SELECT (SELECT count(*)::int FROM cclx_lab_inbox) inbox,
      (SELECT count(*)::int FROM cclx_lab_projections) projections,(SELECT count(*)::int FROM cclx_lab_media_receipts) "mediaReceipts"`)).rows[0]),
    persistMedia:input=>run(()=>{const work=mediaQueue.then(()=>persistMedia(input));mediaQueue=work.catch(()=>{});return work;}),
    close:()=>{if(closePromise)return closePromise;closing=true;closePromise=(async()=>{await Promise.allSettled([...pending]);await pool.end();})();return closePromise;},
  };
}
