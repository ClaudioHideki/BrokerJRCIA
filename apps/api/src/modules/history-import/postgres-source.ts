import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {HistoryImportSelection} from '@jrc/contracts';
import type {OrganizationTransaction} from '../../db/tenant-transaction.js';
import {parseHistorySnapshot,parseHistoryPage,parseHistoryRecords,historySnapshotFingerprint,type HistorySnapshot,type HistoryRecord} from './contract.js';
import {HistoryImportError,type HistorySnapshotSource,type HistorySourceScope} from './types.js';

interface Options {
 transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;
 resolveDatabase(scope:HistorySourceScope):Promise<Pool>;
 verifyOwner(scope:HistorySourceScope,ownerJid:string):Promise<boolean>;
 now?:()=>Date;
}
interface Frozen {manifest:HistorySnapshot;maxRecords:number;pages:unknown[]}
type FrozenMetadata=Pick<Frozen,'manifest'|'maxRecords'>;
function fail(code:string,status:400|404|409|503=409):never{throw new HistoryImportError(code,status);}
/** Exports the provider's stored individual TEXT records. It cannot recover data absent from the engine cache. */
export function createPostgresHistorySource(options:Options):HistorySnapshotSource{
 const now=options.now??(()=>new Date());
 let exportsInFlight=0;
 const read=async(scope:HistorySourceScope,requestId:string)=>options.transact(scope.organizationId,async tx=>
  (await tx.query<{payload:FrozenMetadata}>("SELECT payload-'pages' AS payload FROM history_import_snapshots WHERE organization_id=$1 AND channel_id=$2 AND request_id=$3",[scope.organizationId,scope.channelId,requestId])).rows[0]?.payload);
 const validate=(scope:HistorySourceScope,payload:FrozenMetadata,selection?:HistoryImportSelection)=>{
  if(payload.manifest.organizationId!==scope.organizationId||payload.manifest.channelId!==scope.channelId||payload.manifest.sourceRevision!==scope.sourceRevision||payload.manifest.sourceFingerprint!==scope.sourceFingerprint)fail('HISTORY_SNAPSHOT_SCOPE_CHANGED');
  parseHistorySnapshot(payload.manifest,scope,payload.maxRecords,now());
  if(selection&&(payload.maxRecords!==selection.maxRecords||payload.manifest.from!==selection.from||payload.manifest.to!==selection.to))fail('HISTORY_IMPORT_REQUEST_CONFLICT');
  return payload.manifest;
 };
 return{
  capability:async scope=>{
   const pool=await options.resolveDatabase(scope);
   try{const instance=(await pool.query<{ownerJid:string|null;connectionStatus:string}>('SELECT "ownerJid","connectionStatus" FROM "Instance" WHERE name=$1',[scope.instanceKey])).rows[0];
    const available=!!instance?.ownerJid&&instance.connectionStatus==='open'&&await options.verifyOwner(scope,instance.ownerJid);
    return{available,maxRecords:available?10000:0};
   }catch{return{available:false,maxRecords:0};}
  },
  createSnapshot:async(scope,selection,requestId)=>{
   if(selection.maxRecords>10000)fail('HISTORY_IMPORT_BUDGET',400);
   // Evolution retains the previous number's cache on logout. Only the
   // authenticated current identity epoch can authorize a cache export.
   if(scope.availableFrom&&Date.parse(selection.from)<Date.parse(scope.availableFrom))fail('HISTORY_SOURCE_IDENTITY_RANGE',400);
   const previous=await read(scope,requestId);if(previous)return validate(scope,previous,selection);
   if(exportsInFlight>=2)fail('HISTORY_SOURCE_BUSY',503);
   exportsInFlight++;
   try{
   const pool=await options.resolveDatabase(scope),client=await pool.connect();let open=false;
   let records:HistoryRecord[];
   try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');open=true;
    await client.query("SET LOCAL statement_timeout='10000ms'");
    const instance=(await client.query<{id:string;ownerJid:string|null;connectionStatus:string}>('SELECT id,"ownerJid","connectionStatus" FROM "Instance" WHERE name=$1',[scope.instanceKey])).rows[0];
    if(!instance||instance.connectionStatus!=='open'||!instance.ownerJid||!await options.verifyOwner(scope,instance.ownerJid))fail('HISTORY_SNAPSHOT_SCOPE_CHANGED');
    // Admit bytes before materializing provider text/key values in Node. The same
    // repeatable-read snapshot is used by both queries, including concurrent edits.
    const where=`FROM "Message" WHERE "instanceId"=$1 AND "messageTimestamp">=$2 AND "messageTimestamp"<=$3
       AND key->>'remoteJid' ~ '^(?:[1-9][0-9]{7,14}(:[0-9]+)?@s[.]whatsapp[.]net|[0-9]+(:[0-9]+)?@lid)$'
       AND coalesce(message->>'conversation',message#>>'{extendedTextMessage,text}') IS NOT NULL
      ORDER BY "messageTimestamp",id LIMIT $4`;
    const parameters=[instance.id,Math.ceil(Date.parse(selection.from)/1000),Math.floor(Date.parse(selection.to)/1000),selection.maxRecords+1];
    const admission=(await client.query<{count:number;bytes:string}>(`SELECT count(*)::int AS count,
      coalesce(sum(octet_length(text)+octet_length(key::text)+coalesce(octet_length("pushName"),0)+256),0)::text AS bytes
      FROM (SELECT key,coalesce(message->>'conversation',message#>>'{extendedTextMessage,text}') AS text,"pushName" ${where}) export`,parameters)).rows[0]!;
    if(admission.count>selection.maxRecords||Number(admission.bytes)>14_000_000)fail('HISTORY_IMPORT_BUDGET',400);
    const rows=(await client.query<{key:{id:unknown;remoteJid:unknown;fromMe:unknown};text:string;messageTimestamp:number;pushName:string|null;status:string|null}>(
     `SELECT key,coalesce(message->>'conversation',message#>>'{extendedTextMessage,text}') AS text,"messageTimestamp","pushName",status
      ${where}`,parameters)).rows;
    if(rows.length>selection.maxRecords)fail('HISTORY_IMPORT_BUDGET',400);
    const statuses:Record<string,'SENT'|'DELIVERED'|'READ'|'FAILED'>={SERVER_ACK:'SENT',DELIVERY_ACK:'DELIVERED',READ:'READ',PLAYED:'READ',ERROR:'FAILED'};
    records=rows.map((row,ordinal)=>({ordinal,providerMessageId:row.key.id,remoteJid:row.key.remoteJid,fromMe:row.key.fromMe,
     text:row.text,messageTimestamp:row.messageTimestamp,displayName:row.pushName,...(row.status&&statuses[row.status]?{state:statuses[row.status]}:{})})) as HistoryRecord[];
    await client.query('COMMIT');open=false;
   }catch(error){if(open)await client.query('ROLLBACK');if(error instanceof HistoryImportError)throw error;fail('HISTORY_SOURCE_UNAVAILABLE',503);}
   finally{client.release();}
   const id=randomUUID(),pages:Array<{schemaVersion:1;snapshotId:string;startOrdinal:number;records:HistoryRecord[]}>=[];
   for(let start=0;start<records!.length;start+=100)pages.push({schemaVersion:1,snapshotId:id,startOrdinal:start,records:parseHistoryRecords(records!.slice(start,start+100))});
   const manifest:HistorySnapshot={schemaVersion:1,snapshotId:id,organizationId:scope.organizationId,channelId:scope.channelId,sourceRevision:scope.sourceRevision,
    sourceFingerprint:scope.sourceFingerprint,from:selection.from,to:selection.to,expiresAt:new Date(now().getTime()+86400000).toISOString(),
    totalRecords:records!.length,pageSize:100,pageDigests:pages.map(page=>createHash('sha256').update(JSON.stringify(page.records)).digest('hex'))};
   parseHistorySnapshot(manifest,scope,selection.maxRecords,now());
   for(const page of pages)parseHistoryPage(manifest,page.startOrdinal,page,now());
   const payload:Frozen={manifest,maxRecords:selection.maxRecords,pages};
   if(Buffer.byteLength(JSON.stringify(payload),'utf8')>15_000_000)fail('HISTORY_IMPORT_BUDGET',400);
   const stored=await options.transact(scope.organizationId,async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('history-snapshot-quota:'||$1,0))",[scope.organizationId]);
    await tx.query('SELECT history_import_expire_snapshots()');
    const existing=(await tx.query<{channel_id:string;payload:Frozen}>('SELECT channel_id,payload FROM history_import_snapshots WHERE organization_id=$1 AND request_id=$2',[scope.organizationId,requestId])).rows[0];
    if(existing){if(existing.channel_id!==scope.channelId)fail('HISTORY_IMPORT_REQUEST_CONFLICT');return existing.payload;}
    const budget=(await tx.query<{count:number;bytes:string}>('SELECT count(*)::int AS count,coalesce(sum(octet_length(payload::text)),0)::text AS bytes FROM history_import_snapshots WHERE organization_id=$1',[scope.organizationId])).rows[0]!;
    if(budget.count>=20||Number(budget.bytes)+Buffer.byteLength(JSON.stringify(payload),'utf8')>64*1024*1024)fail('HISTORY_SOURCE_STORAGE_LIMIT',503);
    await tx.query('INSERT INTO history_import_snapshots(organization_id,id,channel_id,request_id,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,request_id) DO NOTHING',
     [scope.organizationId,id,scope.channelId,requestId,payload,manifest.expiresAt]);
    return(await tx.query<{payload:Frozen}>('SELECT payload FROM history_import_snapshots WHERE organization_id=$1 AND channel_id=$2 AND request_id=$3',[scope.organizationId,scope.channelId,requestId])).rows[0]?.payload;
   });
   if(!stored)fail('HISTORY_IMPORT_REQUEST_CONFLICT');return validate(scope,stored,selection);
   }finally{exportsInFlight--;}
  },
  readPage:async(scope,manifest,start)=>{
   if(!Number.isSafeInteger(start)||start<0||start%100!==0)fail('HISTORY_PAGE_INVALID',400);
   const value=await options.transact(scope.organizationId,async tx=>(await tx.query<{manifest:HistorySnapshot;max_records:number;page:unknown}>(
    `SELECT payload->'manifest' AS manifest,(payload->>'maxRecords')::integer AS max_records,payload->'pages'->($4::integer) AS page
     FROM history_import_snapshots WHERE organization_id=$1 AND channel_id=$2 AND id=$3`,[scope.organizationId,scope.channelId,manifest.snapshotId,start/100])).rows[0]);
   if(!value)fail('HISTORY_SNAPSHOT_NOT_FOUND',404);
   validate(scope,{manifest:value.manifest,maxRecords:value.max_records});if(historySnapshotFingerprint(value.manifest)!==historySnapshotFingerprint(manifest))fail('HISTORY_SNAPSHOT_SCOPE_CHANGED');
   const parsed=parseHistoryPage(manifest,start,value.page,now());
   return{schemaVersion:1,snapshotId:manifest.snapshotId,startOrdinal:start,records:parsed.records};
  },
 };
}
