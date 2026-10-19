import {createHash} from 'node:crypto';
import {z} from 'zod';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const ordinal=z.number().int().nonnegative().safe();
const identity={organizationId:z.uuid(),channelId:z.uuid(),sourceRevision:z.number().int().positive().safe(),sourceFingerprint:digest};
const snapshotSchema=z.object({schemaVersion:z.literal(1),snapshotId:z.uuid(),...identity,
 from:z.string().datetime(),to:z.string().datetime(),expiresAt:z.string().datetime(),
 totalRecords:ordinal,pageSize:z.literal(100),pageDigests:z.array(digest)}).strict();
const recordSchema=z.object({ordinal,providerMessageId:z.string().min(1).max(256),
 remoteJid:z.string().max(128).regex(/^(?:[1-9]\d{7,14}(?::\d+)?@s\.whatsapp\.net|\d+(?::\d+)?@lid)$/u),
 fromMe:z.boolean(),messageTimestamp:z.number().int().nonnegative().safe(),text:z.string().min(1).max(4096),
 displayName:z.string().max(512).nullable(),state:z.enum(['SENT','DELIVERED','READ','FAILED']).optional()}).strict();
const pageSchema=z.object({schemaVersion:z.literal(1),snapshotId:z.uuid(),startOrdinal:ordinal,
 records:z.array(recordSchema).max(100)}).strict();
export type HistorySnapshot=z.infer<typeof snapshotSchema>;
export type HistoryRecord=z.infer<typeof recordSchema>;
export type HistoryScope=Pick<HistorySnapshot,'organizationId'|'channelId'|'sourceRevision'|'sourceFingerprint'>;
export function parseHistoryRecords(raw:unknown):HistoryRecord[]{return boundedParse(z.array(recordSchema).max(100),raw,'HISTORY_PAGE_INVALID');}
const fail=(code:string):never=>{throw new Error(code);};
function boundedParse<T>(schema:z.ZodType<T>,value:unknown,code:string):T{
 try{
  if(Buffer.byteLength(JSON.stringify(value),'utf8')>1_048_576)throw new Error();
  const result=schema.safeParse(value);if(!result.success)throw new Error();return result.data;
 }catch{return fail(code);}
}
function assertFresh(snapshot:HistorySnapshot,now:Date){
 if(!Number.isFinite(now.getTime())||Date.parse(snapshot.expiresAt)<=now.getTime())fail('HISTORY_SNAPSHOT_EXPIRED');
}
/** Accept only a frozen, authenticated-provider manifest matched to current server scope. */
export function parseHistorySnapshot(raw:unknown,scope:HistoryScope,maxRecords:number,now:Date):HistorySnapshot{
 if(!Number.isSafeInteger(maxRecords)||maxRecords<=0)fail('HISTORY_IMPORT_BUDGET');
 const value=boundedParse(snapshotSchema,raw,'HISTORY_SNAPSHOT_INVALID');
 if(value.organizationId!==scope.organizationId||value.channelId!==scope.channelId||value.sourceRevision!==scope.sourceRevision
   ||value.sourceFingerprint!==scope.sourceFingerprint)fail('HISTORY_SNAPSHOT_SCOPE_CHANGED');
 if(value.totalRecords>maxRecords)fail('HISTORY_IMPORT_BUDGET');
 if(Date.parse(value.from)>Date.parse(value.to)||value.pageDigests.length!==Math.ceil(value.totalRecords/value.pageSize))fail('HISTORY_SNAPSHOT_INVALID');
 assertFresh(value,now);return value;
}
/** Cursor is an ordinal in an immutable snapshot, never an offset into live provider data. */
export function parseHistoryPage(snapshot:HistorySnapshot,expectedOrdinal:number,raw:unknown,now:Date){
 assertFresh(snapshot,now);
 if(!Number.isSafeInteger(expectedOrdinal)||expectedOrdinal<0||expectedOrdinal>=snapshot.totalRecords)fail('HISTORY_PAGE_NOT_EXPECTED');
 const page=boundedParse(pageSchema,raw,'HISTORY_PAGE_INVALID');
 if(page.snapshotId!==snapshot.snapshotId||page.startOrdinal!==expectedOrdinal)fail('HISTORY_PAGE_SCOPE_CHANGED');
 if(expectedOrdinal%snapshot.pageSize!==0||page.records.length!==Math.min(snapshot.pageSize,snapshot.totalRecords-expectedOrdinal)
   ||page.records.some((record,index)=>record.ordinal!==expectedOrdinal+index||record.messageTimestamp*1000<Date.parse(snapshot.from)
     ||record.messageTimestamp*1000>Date.parse(snapshot.to)))fail('HISTORY_PAGE_INVALID');
 const checksum=createHash('sha256').update(JSON.stringify(page.records)).digest('hex');
 if(checksum!==snapshot.pageDigests[expectedOrdinal/snapshot.pageSize])fail('HISTORY_PAGE_DIGEST_MISMATCH');
 const nextOrdinal=expectedOrdinal+page.records.length;
 return{records:page.records,checksum,nextOrdinal,complete:nextOrdinal===snapshot.totalRecords};
}
export function historySnapshotFingerprint(snapshot:HistorySnapshot):string{
 // Reparse to make caller property insertion order irrelevant to the fingerprint.
 const canonical=boundedParse(snapshotSchema,snapshot,'HISTORY_SNAPSHOT_INVALID');
 return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
