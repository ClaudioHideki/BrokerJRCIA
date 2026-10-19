import {createHash} from 'node:crypto';
import {HistoryImportCapabilitySchema,HistoryImportOperationSchema,HistoryImportSelectionSchema,type HistoryImportSelection} from '@jrc/contracts';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import {lockAttendanceChannel} from '../attendance/repository.js';
import {createHistoryImportStore} from './store.js';
import {persistQrHistoryPage} from './qr-writer.js';
import type {HistoryScope} from './contract.js';
import {HistoryImportError,type HistoryImportService,type HistorySnapshotSource,type HistorySourceScope} from './types.js';

interface Options {transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;source?:HistorySnapshotSource;now?:()=>Date}
type Job=NonNullable<Awaited<ReturnType<ReturnType<typeof createHistoryImportStore>['get']>>>;
function fail(code:string,status:400|403|404|409|503=409):never{throw new HistoryImportError(code,status);}

/** Every page is fetched without SQL locks, then committed under current tenant, membership and identity fences. */
export function createHistoryImportService(options:Options):HistoryImportService{
 const now=options.now??(()=>new Date());
 const authorized=async<T>(org:string,actor:string,work:OrganizationTransaction<T>)=>options.transact(org,async tx=>{
  await tx.query('SELECT tenant_is_active($1)',[org]);
  const membership=(await tx.query<{role:string}>('SELECT role FROM lock_local_attendance_member($1)',[actor])).rows[0];
  if(!membership||!['OWNER','ADMIN'].includes(membership.role))fail('FORBIDDEN',403);
  return work(tx);
 });
 const resolve=async(tx:TenantTransaction,org:string,publicId:string,requireReady=true):Promise<HistorySourceScope>=>{
  const row=(await tx.query<{id:string;upstream_instance_key:string;channel_id:string;status:string;archived_at:Date|null;deleting_at:Date|null}>(
   `SELECT i.id,i.upstream_instance_key,c.id AS channel_id,i.status,i.archived_at,c.deleting_at
    FROM instances i JOIN provider_accounts p ON p.organization_id=i.organization_id AND p.id=i.provider_account_id AND p.provider='BAILEYS'
    JOIN messaging_channels c ON c.organization_id=i.organization_id AND c.instance_id=i.id AND c.provider='BAILEYS'
    WHERE i.organization_id=$1 AND i.id=$2 FOR SHARE OF i`,[org,publicId])).rows[0];
  if(!row)fail('HISTORY_CHANNEL_NOT_FOUND',404);
  await lockAttendanceChannel(tx,org,row.channel_id);
  // Re-read after the channel lock, which serializes deletion and changes of authority.
  const channel=(await tx.query<{deleting_at:Date|null}>('SELECT deleting_at FROM messaging_channels WHERE organization_id=$1 AND id=$2',[org,row.channel_id])).rows[0];
  if(requireReady&&(row.status!=='CONNECTED'||row.archived_at||!channel||channel.deleting_at))fail('HISTORY_CHANNEL_UNAVAILABLE');
  const identity=(await tx.query<{scope_id:string;owner_fingerprint:string|null;binding_fingerprint:string;upstream_instance_key:string;instance_id:string;updated_at:Date}>(
   'SELECT * FROM qr_identity_scopes WHERE organization_id=$1 AND channel_id=$2 FOR SHARE',[org,row.channel_id])).rows[0];
  if(requireReady&&(!identity?.owner_fingerprint||identity.instance_id!==row.id||identity.upstream_instance_key!==row.upstream_instance_key))fail('HISTORY_IDENTITY_NOT_VERIFIED');
  let sourceFingerprint=createHash('sha256').update(JSON.stringify(['history-source:v1',org,row.channel_id,row.id,row.upstream_instance_key,
   identity?.scope_id??null,identity?.owner_fingerprint??null,identity?.binding_fingerprint??null,identity?.updated_at?.toISOString()??null])).digest('hex');
  const scope:HistorySourceScope={organizationId:org,channelId:row.channel_id,instanceId:row.id,instanceKey:row.upstream_instance_key,sourceRevision:1,sourceFingerprint,
   ...(identity?.owner_fingerprint?{ownerFingerprint:identity.owner_fingerprint,availableFrom:identity.updated_at.toISOString()}:{})};
  if(requireReady&&options.source?.bindingFingerprint){scope.providerFingerprint=await options.source.bindingFingerprint(tx,scope);
   sourceFingerprint=createHash('sha256').update(JSON.stringify([sourceFingerprint,scope.providerFingerprint])).digest('hex');scope.sourceFingerprint=sourceFingerprint;}
  return scope;
 };
 const context=async(org:string,actor:string,publicId:string,requireReady=true)=>{
  const scope=await authorized(org,actor,tx=>resolve(tx,org,publicId,requireReady));
  const transact=<T>(_:string,work:OrganizationTransaction<T>)=>authorized(org,actor,work);
  const store=createHistoryImportStore({transact,actorId:actor,assertCurrentScope:async(tx,expected:HistoryScope)=>{
   const current=await resolve(tx,org,publicId);
   if(expected.organizationId!==org||expected.channelId!==current.channelId||expected.sourceRevision!==current.sourceRevision||expected.sourceFingerprint!==current.sourceFingerprint)
    fail('HISTORY_SNAPSHOT_SCOPE_CHANGED');
  },persistHistoricalPage:(tx,records)=>persistQrHistoryPage(tx,org,scope.channelId,records)});
  const match=(job:Job|null)=>{if(!job||job.organizationId!==org||job.channelId!==scope.channelId)fail('HISTORY_IMPORT_NOT_FOUND',404);return job;};
  const view=(job:Job)=>HistoryImportOperationSchema.parse({schemaVersion:1,id:job.id,organizationId:org,channelId:publicId,requestId:job.requestId,
   state:job.state,totalRecords:job.manifest.totalRecords,processedRecords:job.nextOrdinal,importedCount:job.importedCount,duplicateCount:job.duplicateCount,
   revision:job.revision,from:job.manifest.from,to:job.manifest.to,lastError:job.lastError});
  return{scope,store,match,view};
 };
 const source=()=>options.source??fail('HISTORY_SOURCE_NOT_CONFIGURED',503);
 const guarded=async<T>(work:()=>Promise<T>):Promise<T>=>{try{return await work();}catch(error){
  if(error instanceof HistoryImportError)throw error;
  const message=error instanceof Error?error.message:'';
  if(/^HISTORY_[A-Z_]+$/.test(message))throw new HistoryImportError(message,message==='HISTORY_IMPORT_NOT_FOUND'?404:409);
  throw error;
 }};
 return{
  capability:async(org,actor,publicId)=>{
   const base={schemaVersion:1 as const,organizationId:org,channelId:publicId};
   try{const {scope}=await context(org,actor,publicId);
    if(!options.source)return{...base,available:false,reason:'SOURCE_NOT_CONFIGURED',maxRecords:0};
    const capability=await options.source.capability(scope);
    return HistoryImportCapabilitySchema.parse({...base,available:capability.available,reason:capability.available?null:'SOURCE_UNAVAILABLE',maxRecords:capability.available?capability.maxRecords:0,...(capability.available?{availableFrom:scope.availableFrom}:{})});
   }catch(error){if(error instanceof HistoryImportError&&error.statusCode===503)return{...base,available:false,reason:'SOURCE_UNAVAILABLE',maxRecords:0};
    if(error instanceof HistoryImportError&&['HISTORY_CHANNEL_UNAVAILABLE','HISTORY_IDENTITY_NOT_VERIFIED'].includes(error.code))
    return{...base,available:false,reason:error.code==='HISTORY_IDENTITY_NOT_VERIFIED'?'IDENTITY_NOT_VERIFIED':'CHANNEL_UNAVAILABLE',maxRecords:0};throw error;}
  },
  start:(org,actor,publicId,selection:HistoryImportSelection,requestId)=>guarded(async()=>{
   selection=HistoryImportSelectionSchema.parse(selection);const prior=await context(org,actor,publicId,false),existing=await prior.store.byRequest(org,requestId);
   if(existing){const job=prior.match(existing);if(job.manifest.from!==selection.from||job.manifest.to!==selection.to||job.maxRecords!==selection.maxRecords)fail('HISTORY_IMPORT_REQUEST_CONFLICT');return prior.view(job);}
   const c=await context(org,actor,publicId);
   if(c.scope.availableFrom&&Date.parse(selection.from)<Date.parse(c.scope.availableFrom))fail('HISTORY_SOURCE_IDENTITY_RANGE',400);
   const adapter=source(),capability=await adapter.capability(c.scope);
   if(!capability.available)fail('HISTORY_SOURCE_UNAVAILABLE',503);
   if(selection.maxRecords>capability.maxRecords)fail('HISTORY_IMPORT_BUDGET',400);
   const manifest=await adapter.createSnapshot(c.scope,selection,requestId);
   return c.view(await c.store.start(c.scope,requestId,manifest,selection.maxRecords,now()));
  }),
  get:(org,actor,publicId,id)=>guarded(async()=>{const c=await context(org,actor,publicId,false);return c.view(c.match(await c.store.get(org,id)));}),
  byRequest:(org,actor,publicId,requestId)=>guarded(async()=>{const c=await context(org,actor,publicId,false);return c.view(c.match(await c.store.byRequest(org,requestId)));}),
  cancel:(org,actor,publicId,id)=>guarded(async()=>{const c=await context(org,actor,publicId,false);c.match(await c.store.get(org,id));return c.view(await c.store.cancel(org,id));}),
  advance:(org,actor,publicId,id)=>guarded(async()=>{const c=await context(org,actor,publicId),job=c.match(await c.store.get(org,id));
   if(job.state==='CANCELED')fail('HISTORY_IMPORT_CANCELED');if(job.state==='COMPLETED')return c.view(job);
   if(job.manifest.sourceFingerprint!==c.scope.sourceFingerprint||job.manifest.sourceRevision!==c.scope.sourceRevision)fail('HISTORY_SNAPSHOT_SCOPE_CHANGED');
   const page=await source().readPage(c.scope,job.manifest,job.nextOrdinal);
   return c.view((await c.store.applyPage(org,id,page,now())).job);
  }),
 };
}
