import {randomUUID} from 'node:crypto';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import {historySnapshotFingerprint,parseHistorySnapshot,parseHistoryPage,type HistorySnapshot,type HistoryScope,type HistoryRecord} from './contract.js';

type JobRow={id:string;organization_id:string;channel_id:string;request_id:string;manifest:HistorySnapshot;fingerprint:string;
 max_records:string;total_records:string;next_ordinal:string;imported_count:string;duplicate_count:string;state:'OPEN'|'COMPLETED'|'CANCELED';revision:string;actor_id:string|null;last_error:string|null};
function fail(code:string):never{throw new Error(code);}
const asJob=(row:JobRow)=>({id:row.id,organizationId:row.organization_id,channelId:row.channel_id,requestId:row.request_id,manifest:row.manifest,
 state:row.state,actorId:row.actor_id,lastError:row.last_error,maxRecords:Number(row.max_records),nextOrdinal:Number(row.next_ordinal),importedCount:Number(row.imported_count),duplicateCount:Number(row.duplicate_count),revision:Number(row.revision)});
const scopeOf=(row:JobRow):HistoryScope=>({organizationId:row.organization_id,channelId:row.channel_id,
 sourceRevision:row.manifest.sourceRevision,sourceFingerprint:row.manifest.sourceFingerprint});
interface StoreOptions {
 actorId?:string;
 transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;
 /** Database-only current binding/authority check, implemented by the trusted host. */
 assertCurrentScope(tx:TenantTransaction,scope:HistoryScope):Promise<void>;
 /** Historical SQL writes only, on THIS transaction. No HTTP, bot scheduling or send outbox. */
 persistHistoricalPage(tx:TenantTransaction,records:HistoryRecord[]):Promise<{imported:number;duplicates:number}>;
}
/** Private durable core; API authorization and the real historical writer are not wired yet. */
export function createHistoryImportStore(options:StoreOptions){
 const read=async(tx:TenantTransaction,org:string,id:string,lock=false)=>(await tx.query<JobRow>(
  `SELECT * FROM history_import_jobs WHERE organization_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[org,id])).rows[0];
 return{
  async start(scope:HistoryScope,requestId:string,raw:unknown,maxRecords:number,now:Date){
   const manifest=parseHistorySnapshot(raw,scope,maxRecords,now),fingerprint=historySnapshotFingerprint(manifest);
   return options.transact(scope.organizationId,async tx=>{
    await options.assertCurrentScope(tx,scope);
    await tx.query(`INSERT INTO history_import_jobs(organization_id,id,channel_id,request_id,manifest,fingerprint,max_records,total_records,state,actor_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(organization_id,request_id) DO NOTHING`,
     [scope.organizationId,randomUUID(),scope.channelId,requestId,manifest,fingerprint,maxRecords,manifest.totalRecords,manifest.totalRecords===0?'COMPLETED':'OPEN',options.actorId??null]);
    const row=(await tx.query<JobRow>('SELECT * FROM history_import_jobs WHERE organization_id=$1 AND request_id=$2 FOR UPDATE',[scope.organizationId,requestId])).rows[0];
    if(!row||row.fingerprint!==fingerprint||Number(row.max_records)!==maxRecords)fail('HISTORY_IMPORT_REQUEST_CONFLICT');
    return asJob(row);
   });
  },
  async get(org:string,id:string){return options.transact(org,async tx=>{const row=await read(tx,org,id);return row?asJob(row):null;});},
  async byRequest(org:string,requestId:string){return options.transact(org,async tx=>{const row=(await tx.query<JobRow>('SELECT * FROM history_import_jobs WHERE organization_id=$1 AND request_id=$2',[org,requestId])).rows[0];return row?asJob(row):null;});},
  async cancel(org:string,id:string){return options.transact(org,async tx=>{
   const row=await read(tx,org,id,true);if(!row)fail('HISTORY_IMPORT_NOT_FOUND');
   if(row.state!=='OPEN')return asJob(row);
   const updated=(await tx.query<JobRow>(`UPDATE history_import_jobs SET state='CANCELED',revision=revision+1,updated_at=now()
    WHERE organization_id=$1 AND id=$2 RETURNING *`,[org,id])).rows[0]!;
   return asJob(updated);
  });},
  async applyPage(org:string,id:string,raw:unknown,now:Date){return options.transact(org,async tx=>{
   const row=await read(tx,org,id,true);if(!row)fail('HISTORY_IMPORT_NOT_FOUND');
   if(row.state==='CANCELED')fail('HISTORY_IMPORT_CANCELED');
   const scope=scopeOf(row),snapshot=parseHistorySnapshot(row.manifest,scope,Number(row.max_records),now);
   if(historySnapshotFingerprint(snapshot)!==row.fingerprint)fail('HISTORY_IMPORT_MANIFEST_CHANGED');
   await options.assertCurrentScope(tx,scope);
   const start=raw!==null&&typeof raw==='object'&&!Array.isArray(raw)?(raw as Record<string,unknown>).startOrdinal:undefined;
   if(typeof start!=='number')fail('HISTORY_PAGE_INVALID');
   const page=parseHistoryPage(snapshot,start,raw,now);
   const receipt=(await tx.query<{checksum:string}>('SELECT checksum FROM history_import_pages WHERE organization_id=$1 AND import_id=$2 AND start_ordinal=$3',[org,id,start])).rows[0];
   if(receipt){if(receipt.checksum!==page.checksum)fail('HISTORY_PAGE_DIGEST_MISMATCH');return{job:asJob(row),replayed:true};}
   if(row.state!=='OPEN'||Number(row.next_ordinal)!==start)fail('HISTORY_IMPORT_CHECKPOINT_CHANGED');
   const counts=await options.persistHistoricalPage(tx,page.records);
   if(!Number.isSafeInteger(counts.imported)||!Number.isSafeInteger(counts.duplicates)||counts.imported<0||counts.duplicates<0
     ||counts.imported+counts.duplicates!==page.records.length)fail('HISTORY_IMPORT_RECEIPT_INVALID');
   await tx.query(`INSERT INTO history_import_pages(organization_id,channel_id,import_id,start_ordinal,next_ordinal,checksum,imported_count,duplicate_count,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[org,row.channel_id,id,start,page.nextOrdinal,page.checksum,counts.imported,counts.duplicates,options.actorId??row.actor_id]);
   const updated=(await tx.query<JobRow>(`UPDATE history_import_jobs SET next_ordinal=$3,imported_count=imported_count+$4,
    duplicate_count=duplicate_count+$5,state=$6,actor_id=$7,last_error=NULL,next_attempt_at=now(),revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [org,id,page.nextOrdinal,counts.imported,counts.duplicates,page.complete?'COMPLETED':'OPEN',options.actorId??row.actor_id])).rows[0]!;
   return{job:asJob(updated),replayed:false};
  });},
 };
}
