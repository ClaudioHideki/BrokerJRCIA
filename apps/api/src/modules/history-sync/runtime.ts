import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import type {EvolutionFleetRuntime} from '../evolution-fleet/runtime.js';
import type {MediaStore} from '../messaging/media-store.js';
import type {createQrMessagingService} from '../messaging/qr-service.js';
import type {AccountRow} from '../integrations/chatwoot-context.js';
import {readChatwootAccount} from '../integrations/chatwoot-context.js';
import type {ChatwootClient} from '../integrations/chatwoot-client.js';
import {resolveAttendanceScope} from '../attendance/repository.js';
import {hashIdempotencyRequest} from '../instances/idempotency.js';
import {createHistoryRuntimeAuthority} from './authority.js';
import {createHistoryLiveMediaRecovery} from './live-media-recovery.js';
import {HistorySyncScopeSchema,historyCaptureScopeKey,type HistorySyncScope,type HistorySyncRecord} from './contract.js';
import {createHistorySyncStore} from './store.js';
import {createHistorySyncProjector} from './projector.js';
import {createHistoryConsumer,type HistoryDestination} from './consumer.js';
import {createHistorySyncWorker,type HistorySourceReader} from './worker.js';

type MediaReference=Extract<Extract<HistorySyncRecord,{kind:'MESSAGE'}>['content'],{type:'MEDIA'}>;
type Session={id:string;run_id:string;scope:HistorySyncScope;binding:Record<string,unknown>;owner_proof:unknown};
type Options={pool:Pool;environment:NodeJS.ProcessEnv;fleet:EvolutionFleetRuntime;
  transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;media?:MediaStore|undefined;
  client?:(account:AccountRow)=>ChatwootClient;qr?:Pick<ReturnType<typeof createQrMessagingService>,'ingest'>|undefined};
export interface HistorySyncRuntime{
  store:ReturnType<typeof createHistorySyncStore>;
  runOnce(org:string):Promise<{kind:string;live?:string}>;
}
/** Uses the existing worker/pool. No source credential, SQL URL or browser action
 * is a run selector. Source append and application reads share PostgreSQL/RLS. */
export async function createHistorySyncRuntime(options:Options):Promise<HistorySyncRuntime|undefined>{
  const env=options.environment;if(env.HISTORY_SYNC_V2_ENABLED!=='true')return undefined;
  const key=Buffer.from(env.HISTORY_SYNC_SOURCE_KEY??'','base64'),brokerKey=Buffer.from(env.INTEGRATION_ENCRYPTION_KEY??'','base64');
  if(key.length!==32||brokerKey.length!==32||!env.QR_WEBHOOK_SIGNING_KEY)throw Error('HISTORY_SYNC_RUNTIME_CONFIG_INVALID');
  // Kept outside the TypeScript build tree so exactly the same inventoried
  // codec is used by the native engine and the headless Broker worker.
  const moduleUrl=(name:string)=>new URL(`../../../../../integrations/evolution-origin-journal/src/${name}.mjs`,import.meta.url).href;
  const {createOriginJournal}=await import(moduleUrl('journal'));
  const {openSourceOwner}=await import(moduleUrl('postgres-authority'));
  const {createHistoryMediaWorker,createBaileysHistoryMediaDownloader}=await import(moduleUrl('history-media-worker'));
  const {deriveHistoryMediaKeys}=await import(moduleUrl('history-media-download'));
  const {createOriginDispatcher}=await import(moduleUrl('dispatcher'));
  const authority=createHistoryRuntimeAuthority({fleet:options.fleet,signingKey:env.QR_WEBHOOK_SIGNING_KEY});
  const liveMedia=await createHistoryLiveMediaRecovery(options);
  const maximum=Number(env.HISTORY_SYNC_MAX_STAGED_BYTES??16777216);
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>128*1024*1024)throw Error('HISTORY_SYNC_RUNTIME_CONFIG_INVALID');
  const assertScope=async(tx:TenantTransaction,scope:HistorySyncScope)=>{
    await authority.assertCurrentScope(tx,scope);
    const source=(await tx.query<{id:string}>(`SELECT id FROM history_source_sessions WHERE organization_id=$1 AND channel_id=$2
      AND session_generation=$3 AND instance_id=$4 AND state='ACTIVE'`,[scope.organizationId,scope.channelId,scope.sessionGeneration,scope.instanceId])).rows[0];
    if(!source)throw Error('HISTORY_SOURCE_SESSION_CHANGED');
    await tx.query('SELECT history_source_assert($1)',[source.id]);
  };
  const check=(scope:HistorySyncScope)=>options.transact(scope.organizationId,tx=>assertScope(tx,scope));
  const destination=async(tx:TenantTransaction,scope:HistorySyncScope)=>{
    const d=await resolveAttendanceScope(tx,scope.organizationId,scope.channelId),a=await readChatwootAccount(tx,scope.organizationId);
    if(!d||!a||!scope.historyAccountIdentity)throw Error('HISTORY_SYNC_DESTINATION_UNCONFIGURED');
    // Retain credential and destination revisions through the projection COMMIT.
    await tx.query('SELECT organization_id FROM chatwoot_accounts WHERE organization_id=$1 FOR SHARE',[scope.organizationId]);
    return{destination:{...d,instanceId:scope.instanceId,historyAccountIdentity:scope.historyAccountIdentity},
      authorityFingerprint:hashIdempotencyRequest([d,a.base_url,a.credential_version])};
  };
  const store=createHistorySyncStore({transact:options.transact,encryptionKey:brokerKey,maxStagedBytes:maximum,assertCurrentScope:assertScope,resolveDestination:destination});
  const readConsumer=async(d:HistoryDestination)=>{
    const a=await options.transact(d.organizationId,async tx=>{
      const scope=(await tx.query<{scope:HistorySyncScope;session_generation:string}>(`SELECT s.scope,s.session_generation FROM history_source_sessions s
        WHERE s.organization_id=$1 AND s.channel_id=$2 AND s.state='ACTIVE'`,[d.organizationId,d.channelId])).rows[0];
      if(!scope)throw Error('HISTORY_SOURCE_SESSION_CHANGED');
      await tx.query('SELECT history_source_assert(id) FROM history_source_sessions WHERE organization_id=$1 AND channel_id=$2 AND state=\'ACTIVE\'',[d.organizationId,d.channelId]);
      const current=await resolveAttendanceScope(tx,d.organizationId,d.channelId),account=await readChatwootAccount(tx,d.organizationId);
      if(!current||!account||hashIdempotencyRequest(current)!==hashIdempotencyRequest({organizationId:d.organizationId,channelId:d.channelId,
        integrationId:d.integrationId,accountId:d.accountId,inboxId:d.inboxId,destinationRevision:d.destinationRevision}))throw Error('HISTORY_SYNC_DESTINATION_CHANGED');
      return account;
    });
    if(!options.client)throw Error('HISTORY_SYNC_DESTINATION_UNCONFIGURED');
    // All requests are implemented by the existing validated Chatwoot client.
    return options.client(a).historySyncV2();
  };
  const consumer=(_d:HistoryDestination):ReturnType<typeof createHistoryConsumer>=>({
    capability:async(d)=>(await readConsumer(d)).capability(d),
    bootstrap:async(d,input)=>(await readConsumer(d)).bootstrap(d,input),
    message:async(d,input)=>(await readConsumer(d)).message(d,input),
    receipt:async(d,receipt,sha)=>(await readConsumer(d)).receipt(d,receipt,sha),
    upload:async(d,reference,bytes)=>(await readConsumer(d)).upload(d,reference,bytes),
  });
  const projector=createHistorySyncProjector({store,consumer,media:async(scope,id)=>{
    if(!options.media)throw Error('HISTORY_MEDIA_STORAGE_UNAVAILABLE');
    return Buffer.from((await options.media.read(scope.organizationId,id,{authorize:tx=>assertScope(tx as TenantTransaction,scope)})).bytes);
  }});
  return{store,async runOnce(org:string){
    const s=await options.transact(org,async tx=>{
      const r=(await tx.query<Session>(`SELECT s.id,s.run_id,s.scope,s.binding,s.owner_proof FROM history_source_sessions s
        JOIN history_sync_runs r ON r.organization_id=s.organization_id AND r.id=s.run_id
        WHERE s.organization_id=$1 AND s.state='ACTIVE' ORDER BY s.last_polled_at NULLS FIRST,s.id LIMIT 1`,[org])).rows[0];
      if(r)await tx.query('UPDATE history_source_sessions SET last_polled_at=clock_timestamp() WHERE organization_id=$1 AND id=$2',[org,r.id]);return r;
    });
    if(!s)return{kind:'IDLE'} as const;
    const provisional=HistorySyncScopeSchema.parse(s.scope);await check(provisional);
    const scopedPool={query:(sql:string,values?:unknown[])=>options.transact(org,tx=>tx.query(sql,values)),connect:async()=>{
      const client=await options.pool.connect();
      return{release:()=>client.release(),query:async(sql:string,values?:unknown[])=>{
        const result=await client.query(sql,values);if(sql==='BEGIN')await client.query("SELECT set_config('app.organization_id',$1,true)",[org]);return result;
      }};
    }};
    const journal=createOriginJournal({pool:scopedPool,encryptionKey:key,liveVersion:2,history:{maxStagedBytes:maximum,captureMedia:true},
      assertTransaction:(tx:TenantTransaction)=>assertScope(tx,provisional)});
    // Live text delivery has a separate budget and never invokes the historical writer.
    let live='DISABLED';
    if(options.qr){
      const dispatcher=createOriginDispatcher({env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},journal,resolveBinding:async()=>{await check(provisional);return s.binding;},
        deliver:async({id,body}:{id:string;body:unknown})=>{
          const snapshot=await options.fleet.capture(org,(s.binding.instanceName as string));
          const webhook=await options.fleet.webhook(org,(s.binding.instanceName as string),provisional.channelId);
          await options.transact(org,async tx=>{await assertScope(tx,provisional);await options.fleet.assert(snapshot,tx);});
          const k=(body as {data?:{key?:{remoteJid?:string;remoteJidAlt?:string}}}).data?.key;
          const sourceIdentity=k&&[k.remoteJid,k.remoteJidAlt].some(jid=>jid?.endsWith('@lid'))
            ?await options.transact(org,async tx=>{await assertScope(tx,provisional);
              if(!s.owner_proof)throw Error('HISTORY_SYNC_OWNER_UNVERIFIED');
              const ownerPhone:string=openSourceOwner(key,s.id,s.owner_proof);
              const scope=await authority.resolve(tx,org,provisional.channelId,provisional.sessionGeneration,ownerPhone);
              if(!scope.identityScopeId)throw Error('HISTORY_SYNC_OWNER_UNVERIFIED');
              return{sessionId:s.id,identityScopeId:scope.identityScopeId,ownerPhone};}):undefined;
          await liveMedia?.prepare(org,provisional.channelId,body,s.binding.instanceName as string);
          const receipt=await options.qr!.ingest(provisional.channelId,`Bearer ${webhook.token}`,body,{projectionVersion:2,sourceEventId:id,
            contentSha256:createHash('sha256').update(JSON.stringify(body)).digest('hex'),...(sourceIdentity?{sourceIdentity}:{})});
          // Internal ingestion reports a domain status (accepted/duplicate),
          // not an HTTP status. Only the correlated durable receipt is the ACK.
          return{...receipt,status:200};
        }});
      live=(await dispatcher.runOnce(s.binding)).kind;
    }
    // Source custody reconciliation is independent of a paused historical run.
    if(options.media&&liveMedia)await liveMedia.reconcile(org,provisional.channelId,options.media);
    const current=await store.get(org,s.run_id);
    if(!current)throw Error('HISTORY_SYNC_NOT_FOUND');
    // Pausing/finishing history cannot pause the independently durable live lane.
    if(current.state!=='RUNNING')return{kind:'INACTIVE',state:current.state,live};
    let scope=provisional;
    if(s.owner_proof){
      try{
        scope=await options.transact(org,async tx=>{await assertScope(tx,provisional);
          return authority.resolve(tx,org,provisional.channelId,provisional.sessionGeneration,openSourceOwner(key,s.id,s.owner_proof));});
        await store.promote(s.run_id,scope,new Date());
      }catch(error){if(!(error instanceof Error)||error.message!=='HISTORY_SYNC_OWNER_UNVERIFIED')throw error;}
    }
    const mediaAuthority=async(tx:TenantTransaction|null,current=scope)=>tx?assertScope(tx,current):check(current);
    const media=options.media?createHistoryMediaWorker({journal:journal.history,assertCurrentScope:mediaAuthority,download:createBaileysHistoryMediaDownloader({getMediaKeys:deriveHistoryMediaKeys}),
      persist:async(reference:MediaReference,bytes:Buffer)=>{
        const id=await options.media!.writeHistoryUpload(org,scope.channelId,{uploadKind:'HISTORY',referenceId:reference.referenceId,runId:s.run_id,
          captureScopeKey:historyCaptureScopeKey(scope),sha256:reference.sha256},{bytes,mimeType:reference.mimeType,fileName:reference.filename,
          kind:reference.mediaType.toLowerCase() as 'image'|'audio'|'video'|'document'|'sticker'},{authorize:tx=>assertScope(tx as TenantTransaction,scope)});
        const physical=await options.media!.read(org,id,{authorize:tx=>assertScope(tx as TenantTransaction,scope)});
        if(physical.bytes.byteLength!==reference.byteSize||createHash('sha256').update(physical.bytes).digest('hex')!==reference.sha256)throw Error('HISTORY_MEDIA_INTEGRITY');
        return{protocol:'jrc-history-media/2',persisted:true,scopeKey:historyCaptureScopeKey(scope),runId:s.run_id,referenceId:id,sha256:reference.sha256,byteSize:reference.byteSize};
      }}):undefined;
    const worker=createHistorySyncWorker({enabled:true,store,source:journal.history as HistorySourceReader,projector,...(media?{media}:{}),assertAdmission:check});
    return{...await worker.runOnce(scope,s.run_id,new Date()),live};
  }};
}
