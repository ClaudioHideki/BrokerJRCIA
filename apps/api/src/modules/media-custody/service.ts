import {createHash} from 'node:crypto';
import {MediaCustodyRequestSchema,type MediaCustodyRequest,type MediaCustodyReceipt} from '@jrc/contracts';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import {requireActiveOrganization} from '../tenancy/operational-limits.js';
import {requireCurrentPartnerKey,recheckCurrentPartnerKey} from '../messaging/partner-authority.js';
import {lockAttendanceChannelRead} from '../attendance/repository.js';

export class MediaCustodyError extends Error {
 constructor(readonly code:string,readonly statusCode:number){super(code);}
}
interface Row extends Omit<MediaCustodyReceipt,'acceptedAt'> {acceptedAt:Date;requestHash:string;idempotencyKey:string}
const columns=`id,organization_id AS "organizationId",schema_version AS "schemaVersion",channel_id AS "channelId",message_id AS "messageId",media_id AS "mediaId",endpoint_id AS "endpointId",destination_version AS "destinationVersion",client_receipt_id AS "clientReceiptId",byte_size AS "byteSize",sha256,storage_object_id AS "storageObjectId",attestation,accepted_at AS "acceptedAt",request_hash AS "requestHash",idempotency_key AS "idempotencyKey"`;
const view=(row:Row):MediaCustodyReceipt=>{const {requestHash:_,idempotencyKey:__,...receipt}=row;return {...receipt,acceptedAt:row.acceptedAt.toISOString()};};
const scopes=['media:archive'] as const;

export function createMediaCustodyService(options:{transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>}){
 async function authorize(tx:TenantTransaction,org:string,key:string){
  await requireActiveOrganization(tx,org);
  await requireCurrentPartnerKey(tx,org,key,scopes);
  const controlBinding=await tx.query('SELECT api_key_id FROM chatwoot_control_bindings WHERE organization_id=$1 AND api_key_id=$2',[org,key]);
  if(controlBinding.rows.length)throw new MediaCustodyError('MEDIA_CUSTODY_CONTROL_CREDENTIAL',403);
 }
 async function validateReference(tx:TenantTransaction,org:string,key:string,input:MediaCustodyRequest){
  await lockAttendanceChannelRead(tx,org,input.channelId);
  const endpoint=(await tx.query(`SELECT id FROM partner_webhook_endpoints WHERE organization_id=$1 AND id=$2 AND status='ACTIVE' FOR SHARE`,[org,input.endpointId])).rows[0];
  if(!endpoint)throw new MediaCustodyError('MEDIA_DESTINATION_NOT_ACTIVE',409);
  const media=(await tx.query<{status:string;byteSize:number;sha256:string}>(`SELECT a.status,a.byte_size AS "byteSize",a.sha256 FROM messaging_messages m JOIN messaging_media a
   ON a.organization_id=m.organization_id AND a.channel_id=m.channel_id AND a.id=m.media_id
   WHERE m.organization_id=$1 AND m.channel_id=$2 AND m.id=$3 AND a.id=$4 FOR SHARE OF m, a`,[org,input.channelId,input.messageId,input.mediaId])).rows[0];
  // Wall clock expiry can change while waiting on endpoint/message/media locks.
  await recheckCurrentPartnerKey(tx,org,key,scopes);
  await requireActiveOrganization(tx,org);
  if(!media)throw new MediaCustodyError('MEDIA_REFERENCE_NOT_FOUND',404);
  if(media.status!=='READY')throw new MediaCustodyError('MEDIA_NOT_READY',409);
  if(media.byteSize!==input.byteSize||media.sha256!==input.sha256)throw new MediaCustodyError('MEDIA_CUSTODY_INTEGRITY_MISMATCH',409);
 }
 async function read(tx:TenantTransaction,org:string,key:string,id:string){
  await authorize(tx,org,key);
  const row=(await tx.query<Row>(`SELECT ${columns} FROM media_custody_receipts WHERE organization_id=$1 AND id=$2`,[org,id])).rows[0];
  if(!row)throw new MediaCustodyError('MEDIA_CUSTODY_NOT_FOUND',404);
  await recheckCurrentPartnerKey(tx,org,key,scopes);
  return row;
 }
 return {
  record:(org:string,key:string,value:MediaCustodyRequest,idempotencyKey:string)=>options.transact(org,async tx=>{
   const input=MediaCustodyRequestSchema.parse(value);
   if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(idempotencyKey))throw new MediaCustodyError('INVALID_IDEMPOTENCY_KEY',400);
   await authorize(tx,org,key);
   // Organization scope preserves replay across authorized key rotation and serializes identities.
   await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('media-custody:'||$1,0))",[org]);
   await validateReference(tx,org,key,input);
   const requestHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
   // Receipts are immutable and writes are serialized by the tenant advisory lock.
   // A row-locking SELECT would require UPDATE, intentionally denied on this ledger.
   const existing=(await tx.query<Row>(`SELECT ${columns} FROM media_custody_receipts WHERE organization_id=$1 AND
    (idempotency_key=$2 OR (endpoint_id=$3 AND client_receipt_id=$4) OR (endpoint_id=$3 AND message_id=$5 AND media_id=$6))`,[org,idempotencyKey,input.endpointId,input.clientReceiptId,input.messageId,input.mediaId])).rows;
   await recheckCurrentPartnerKey(tx,org,key,scopes);
   if(existing.length){
    if(existing.length!==1||existing[0]!.requestHash!==requestHash||existing[0]!.idempotencyKey!==idempotencyKey)throw new MediaCustodyError('MEDIA_CUSTODY_CONFLICT',409);
    return {schemaVersion:1 as const,receipt:view(existing[0]!),replayed:true};
   }
   const row=(await tx.query<Row>(`INSERT INTO media_custody_receipts(organization_id,authorizing_api_key_id,idempotency_key,request_hash,
    channel_id,message_id,media_id,endpoint_id,destination_version,client_receipt_id,byte_size,sha256,storage_object_id,attestation)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${columns}`,[org,key,idempotencyKey,requestHash,input.channelId,input.messageId,input.mediaId,input.endpointId,input.destinationVersion,input.clientReceiptId,input.byteSize,input.sha256,input.storageObjectId,input.attestation])).rows[0]!;
   await recheckCurrentPartnerKey(tx,org,key,scopes);
   return {schemaVersion:1 as const,receipt:view(row),replayed:false};
  }),
  get:(org:string,key:string,id:string)=>options.transact(org,async tx=>({schemaVersion:1 as const,receipt:view(await read(tx,org,key,id))})),
  evaluate:(org:string,key:string,id:string)=>options.transact(org,async tx=>{
   await read(tx,org,key,id);
   return {schemaVersion:1 as const,receiptId:id,policy:'KEEP' as const,eligibleForDeletion:false as const,reason:'KEEP_POLICY' as const,physicalStorageVerified:false as const};
  }),
 };
}
export type MediaCustodyService=ReturnType<typeof createMediaCustodyService>;
