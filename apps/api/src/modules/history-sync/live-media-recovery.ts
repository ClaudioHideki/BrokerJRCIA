import {createHash} from 'node:crypto';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import type {EvolutionFleetRuntime} from '../evolution-fleet/runtime.js';
import type {MediaAsset,MediaStore} from '../messaging/media-store.js';
import {HistorySyncScopeSchema,type HistorySyncScope} from './contract.js';
import {createHistoryRuntimeAuthority} from './authority.js';
import {normalizeQrEvent} from '../messaging/qr-events.js';
import {registerPendingMedia} from '../messaging/media-store.js';

type Options={environment:NodeJS.ProcessEnv;fleet:EvolutionFleetRuntime;
 transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>};
type Session={id:string;run_id:string;scope:HistorySyncScope};
/** Source keys stay in the private encrypted journal. A live descriptor is never
 * materialized as a historical MESSAGE and never depends on the engine cache. */
export async function createHistoryLiveMediaRecovery(options:Options){
 const env=options.environment;if(env.HISTORY_SYNC_V2_ENABLED!=='true')return undefined;
 const key=Buffer.from(env.HISTORY_SYNC_SOURCE_KEY??'','base64');if(key.length!==32||!env.QR_WEBHOOK_SIGNING_KEY)throw Error('HISTORY_SYNC_RUNTIME_CONFIG_INVALID');
 const url=(name:string)=>new URL(`../../../../../integrations/evolution-origin-journal/src/${name}.mjs`,import.meta.url).href;
 const {createHistorySourceMedia}=await import(url('history-source-media'));
 const {createBaileysHistoryMediaDownloader,deriveHistoryMediaKeys}=await import(url('history-media-download'));
 const {collectHistoryMedia}=await import(url('history-media-worker'));
 const download=createBaileysHistoryMediaDownloader({getMediaKeys:deriveHistoryMediaKeys});
 const authority=createHistoryRuntimeAuthority({fleet:options.fleet,signingKey:env.QR_WEBHOOK_SIGNING_KEY});
 const current=(tx:TenantTransaction,org:string,channel:string)=>tx.query<Session>(`SELECT id,run_id,scope FROM history_source_sessions
  WHERE organization_id=$1 AND channel_id=$2 AND state='ACTIVE'`,[org,channel]).then(r=>r.rows[0]);
 const assert=async(tx:TenantTransaction,s:Session)=>{await authority.assertCurrentScope(tx,HistorySyncScopeSchema.parse(s.scope));await tx.query('SELECT history_source_assert($1)',[s.id]);};
 const source=(tx:TenantTransaction)=>createHistorySourceMedia({pool:tx,encryptionKey:key,transact:async()=>{throw Error('READ_ONLY_SOURCE_PORT');}});
 const read=async(asset:MediaAsset)=>options.transact(asset.organization_id,async tx=>{
  const s=await current(tx,asset.organization_id,asset.channel_id);if(!s)return null;
  await assert(tx,s);const value=await source(tx).readLive(s.scope,s.run_id,asset.source_key);
  if(!value)return null;
  if(value.reference.mediaType.toLowerCase()!==asset.kind)throw Error('HISTORY_SOURCE_MEDIA_CONFLICT');
  return{s,value};
 });
 return{
  async prepare(org:string,channel:string,payload:unknown,instanceName:string){
   return options.transact(org,async tx=>{
    const s=await current(tx,org,channel);if(!s)throw Error('HISTORY_SOURCE_SESSION_CHANGED');await assert(tx,s);
    for(const raw of normalizeQrEvent(payload,instanceName)){
     const event=raw.kind==='identity-pending'?raw.event:raw;
     if('media'in event){
      // Require the matching encrypted source descriptor before creating a QR
      // download obligation. This separate COMMIT survives an ingress retry.
      if(!await source(tx).readLive(s.scope,s.run_id,event.media.sourceKey))throw Error('HISTORY_SOURCE_LIVE_MEDIA_UNAVAILABLE');
      await registerPendingMedia(tx,org,channel,event.media);
     }
    }
   });
  },
  async download(asset:MediaAsset){
   if(asset.source!=='QR')return undefined;const found=await read(asset);if(!found)return undefined;
   const signal=AbortSignal.timeout(25000),stream=await download(found.value.descriptor,{signal});
   const bytes:Buffer=await collectHistoryMedia(stream,found.value.reference,signal);
   try{await options.transact(asset.organization_id,tx=>assert(tx,found.s));}
   catch(error){bytes.fill(0);throw error;}
   return{bytes,mimeType:found.value.reference.mimeType,fileName:asset.file_name,kind:asset.kind};
  },
  async reconcile(org:string,channel:string,media:Pick<MediaStore,'read'>){
   const candidate=await options.transact(org,async tx=>{
    const s=await current(tx,org,channel);if(!s)return null;await assert(tx,s);
    const asset=(await tx.query<MediaAsset>(`SELECT m.* FROM messaging_media m JOIN jrc_evolution_origin.history_media h
     ON h.live_message_key=encode(sha256(convert_to(m.source_key,'UTF8')),'hex') AND h.run_id=$3
     AND h.scope_key=$4 WHERE m.organization_id=$1 AND m.channel_id=$2 AND m.source='QR' AND m.status='READY'
     AND h.state='PENDING' ORDER BY h.created_at,h.reference_id LIMIT 1`,[org,channel,s.run_id,
      (await import(url('history-projection'))).historyCaptureScopeKey(s.scope)])).rows[0];
    if(!asset)return null;const value=await source(tx).readLive(s.scope,s.run_id,asset.source_key);return value?{s,asset,value}:null;
   });
   if(!candidate)return{kind:'IDLE'};
   // Read the actual private object (or legacy encrypted bytes), not its status.
   const file=await media.read(org,candidate.asset.id,{authorize:tx=>assert(tx as TenantTransaction,candidate.s)});
   const r=candidate.value.reference;
   if(file.bytes.byteLength!==r.byteSize||createHash('sha256').update(file.bytes).digest('hex')!==r.sha256||file.mimeType!==r.mimeType)
    throw Error('HISTORY_MEDIA_INTEGRITY');
   await options.transact(org,async tx=>{await assert(tx,candidate.s);
    await tx.query(`UPDATE jrc_evolution_origin.history_media SET state='READY',persisted_at=clock_timestamp(),last_error=NULL
     WHERE scope_key=$1 AND run_id=$2 AND reference_id=$3 AND state='PENDING'`,[
     (await import(url('history-projection'))).historyCaptureScopeKey(candidate.s.scope),candidate.s.run_id,r.referenceId]);
   });return{kind:'READY'};
  },
 };
}
