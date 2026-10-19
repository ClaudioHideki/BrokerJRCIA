import {lockAttendanceChannel} from '../attendance/repository.js';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {HistoryRecord} from './contract.js';
import {createPostgresMessagingRepository} from '../messaging/repository.js';
import {persistQrContactEvent} from '../messaging/qr-contact-persistence.js';
import {qrPhone} from '../messaging/qr-events.js';
import {requireActiveOrganization} from '../tenancy/operational-limits.js';

function fail(code:string):never{throw Object.assign(new Error(code),{code,status:409});}
/** Consumes validated snapshot records; only SQL on the caller's tenant transaction. */
export async function persistQrHistoryPage(tx:TenantTransaction,org:string,channelId:string,records:HistoryRecord[]){
 if(records.length>100)fail('HISTORY_PAGE_INVALID');
 const repository=createPostgresMessagingRepository();
 const candidate=await repository.findChannel(tx,org,channelId);
 if(!candidate||candidate.provider!=='BAILEYS'||!candidate.instanceId)fail('HISTORY_CHANNEL_UNAVAILABLE');
 // Match live ingress: instance SHARE, then channel NO KEY UPDATE. Never upgrade
 // an instance lock after taking a channel lock (two import jobs can deadlock).
 await lockAttendanceChannel(tx,org,channelId);
 const channel=await repository.findChannel(tx,org,channelId);
 if(!channel||channel.provider!=='BAILEYS'||!channel.instanceId)fail('HISTORY_CHANNEL_UNAVAILABLE');
 await requireActiveOrganization(tx,org);
 if(!(await tx.query("SELECT id FROM instances WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL AND status='CONNECTED' FOR SHARE",[org,channel.instanceId])).rowCount)
  fail('HISTORY_CHANNEL_UNAVAILABLE');
 // An unresolved identity must not turn into a committed 'imported' ordinal.
 const mapped:Array<{item:HistoryRecord;externalId:string}>=[];
 for(const item of records){
  let externalId=qrPhone(item.remoteJid);
  if(!externalId&&/^\d+(?::\d+)?@lid$/u.test(item.remoteJid)){
   const lid=item.remoteJid.replace(/:\d+(?=@)/u,'');
   externalId=(await tx.query<{phone:string}>(
    `SELECT a.phone FROM qr_contact_aliases a JOIN qr_identity_scopes s
      ON s.organization_id=a.organization_id AND s.channel_id=a.channel_id AND s.scope_id=a.scope_id
     JOIN instances i ON i.organization_id=s.organization_id AND i.id=s.instance_id AND i.upstream_instance_key=s.upstream_instance_key
     WHERE a.organization_id=$1 AND a.channel_id=$2 AND s.instance_id=$3 AND a.lid=$4
       AND a.status='CONFIRMED' AND s.owner_fingerprint IS NOT NULL AND i.archived_at IS NULL AND i.status='CONNECTED'
     FOR SHARE OF s,a`,[org,channelId,channel.instanceId,lid])).rows[0]?.phone;
  }
  if(!externalId)fail('HISTORY_IDENTITY_UNRESOLVED');mapped.push({item,externalId});
 }
 let imported=0,duplicates=0;
 for(const {item,externalId} of mapped){
  const created=await persistQrContactEvent(tx,channel,{kind:item.fromMe?'outbound':'message',historical:true,
   upstreamMessageId:item.providerMessageId,externalId,displayName:item.displayName,content:{type:'TEXT',text:item.text},occurredAt:new Date(item.messageTimestamp*1000),
   ...(item.state?{historicalState:item.state}:{})});
  if(created===true)imported++;else if(created===false)duplicates++;else fail('HISTORY_WRITER_RESULT_INVALID');
 }
 return{imported,duplicates};
}
