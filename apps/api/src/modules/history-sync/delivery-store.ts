import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
import { hashIdempotencyRequest } from '../instances/idempotency.js';
import { HistorySyncScopeSchema, type HistorySyncScope, type HistorySyncRecord } from './contract.js';
import { HistoryDestinationSchema, type HistoryDestination, type HistoryConsumerReceipt } from './consumer.js';
import { normalizeHistoryJid } from './writer.js';
import type { MessageContent } from '../messaging/types.js';

export type HistoryDestinationAuthority = { destination: HistoryDestination; authorityFingerprint: string };
type Record = Extract<HistorySyncRecord,{kind:'MESSAGE'|'CHAT'}>;
export type HistoryProjectionClaim = {
  kind:'CLAIMED'; id:string; lease:string; authority:HistoryDestinationAuthority; record:Record;
  conversationId:string; contactId:string; messageId:string|null; displayName:string|null; bootstrapOccurredAt:number;
  remotePeerId:string; existingConversationId:number|null; bootstrapReceipt:HistoryConsumerReceipt|null;
  receipt:HistoryConsumerReceipt|null;
};
type Row = {id:string;chunk_id:string;record_index:number;destination:HistoryDestination|null;authority_fingerprint:string|null;
  attempts:number;receipt:HistoryConsumerReceipt|null;lease_token:string|null};
export interface HistoryProjectionOptions {
  transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;
  assertCurrentScope(tx:TenantTransaction,scope:HistorySyncScope):Promise<void>;
  resolveDestination?(tx:TenantTransaction,scope:HistorySyncScope):Promise<HistoryDestinationAuthority>;
}
function fail(code:string):never {throw Error(code);}
const authoritySchema=z.strictObject({destination:HistoryDestinationSchema,authorityFingerprint:z.string().regex(/^[a-f0-9]{64}$/u)});
/** This port is private. The host must lock membership, destination and credential
 * revisions in resolveDestination and source ownership in assertCurrentScope. */
export function createHistoryProjectionStore(options:HistoryProjectionOptions,
  record:(tx:TenantTransaction,scope:HistorySyncScope,run:string,chunk:string,index:number,now:Date)=>Promise<HistorySyncRecord>) {
  const fence=async(tx:TenantTransaction,scope:HistorySyncScope,run:string)=>{
    await options.assertCurrentScope(tx,scope);
    await lockAttendanceChannel(tx,scope.organizationId,scope.channelId);
    const r=(await tx.query<{state:string;history_account_identity:string;instance_id:string;identity_scope_id:string;engine_id:string;
      engine_generation:string;session_generation:string;binding_fingerprint:string;owner_fingerprint:string}>(`SELECT * FROM history_sync_runs
      WHERE organization_id=$1 AND channel_id=$2 AND id=$3 FOR UPDATE`,[scope.organizationId,scope.channelId,run])).rows[0];
    if(!r || r.history_account_identity!==scope.historyAccountIdentity)fail('HISTORY_SYNC_SCOPE_CHANGED');
    if(r.instance_id!==scope.instanceId || r.identity_scope_id!==scope.identityScopeId || r.engine_id!==scope.engineId
      || Number(r.engine_generation)!==scope.engineGeneration || r.session_generation!==scope.sessionGeneration
      || r.binding_fingerprint!==scope.bindingFingerprint || r.owner_fingerprint!==scope.ownerFingerprint)fail('HISTORY_SYNC_SCOPE_CHANGED');
    if(r.state!=='RUNNING')fail('HISTORY_SYNC_NOT_RUNNING');
    if(!options.resolveDestination)fail('HISTORY_SYNC_DESTINATION_UNCONFIGURED');
    const authority=authoritySchema.parse(await options.resolveDestination!(tx,scope));
    if(authority.destination.organizationId!==scope.organizationId || authority.destination.channelId!==scope.channelId
      || authority.destination.historyAccountIdentity!==scope.historyAccountIdentity || authority.destination.instanceId!==scope.instanceId)
      fail('HISTORY_SYNC_DESTINATION_CHANGED');
    return authority;
  };
  const unchanged=(row:Row,a:HistoryDestinationAuthority)=>{
    if(row.destination && (hashIdempotencyRequest(row.destination)!==hashIdempotencyRequest(a.destination)
      || row.authority_fingerprint!==a.authorityFingerprint))fail('HISTORY_SYNC_DESTINATION_CHANGED');
  };
  const complete=async(tx:TenantTransaction,scope:HistorySyncScope,run:string)=>{
    await tx.query(`UPDATE history_sync_runs r SET projected_messages=(SELECT count(*) FROM history_sync_deliveries d
      JOIN history_sync_record_results s USING(organization_id,run_id,chunk_id,record_index)
      WHERE d.organization_id=r.organization_id AND d.run_id=r.id AND d.state='DONE' AND s.disposition='CREATED'),
      projection=CASE WHEN EXISTS(SELECT 1 FROM history_sync_deliveries d WHERE d.organization_id=r.organization_id AND d.run_id=r.id AND d.state='BLOCKED') THEN 'BLOCKED'
      WHEN EXISTS(SELECT 1 FROM history_sync_deliveries d WHERE d.organization_id=r.organization_id AND d.run_id=r.id AND d.state<>'DONE')
      THEN 'RUNNING' ELSE CASE WHEN r.persistence='COMPLETE' THEN 'COMPLETE' ELSE 'RUNNING' END END
      WHERE r.organization_id=$1 AND r.id=$2`,[scope.organizationId,run]);
    await tx.query(`UPDATE history_sync_runs SET state='COMPLETED' WHERE organization_id=$1 AND id=$2 AND state='RUNNING'
      AND capture='COMPLETE' AND persistence='COMPLETE' AND projection='COMPLETE' AND pending_media=0 AND unavailable_media=0
      AND blocked_records=0 AND persisted_messages+duplicate_messages=captured_messages AND projected_messages=persisted_messages`,[scope.organizationId,run]);
  };
  return {
    async blockProjection(raw:HistorySyncScope,run:string,claim:HistoryProjectionClaim,code:'HISTORY_CONSUMER_UNSUPPORTED'|'HISTORY_CONSUMER_MEDIA_LIMIT') {
      const scope=HistorySyncScopeSchema.parse(raw);
      if(!['HISTORY_CONSUMER_UNSUPPORTED','HISTORY_CONSUMER_MEDIA_LIMIT'].includes(code))fail('HISTORY_SYNC_RETRY_CODE_INVALID');
      await options.transact(scope.organizationId,async tx=>{
        const authority=await fence(tx,scope,run);
        const row=(await tx.query<Row>('SELECT * FROM history_sync_deliveries WHERE organization_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',
          [scope.organizationId,run,claim.id])).rows[0];
        if(!row || row.lease_token!==claim.lease)fail('HISTORY_SYNC_LEASE_CHANGED');
        unchanged(row,authority);
        await tx.query(`UPDATE history_sync_deliveries SET state='BLOCKED',last_error=$3,lease_token=NULL,lease_until=NULL
          WHERE organization_id=$1 AND id=$2`,[scope.organizationId,claim.id,code]);
        // Capture/persistence remain independent; this failure cannot discard
        // source pages or admit a fallback live send.
        await tx.query("UPDATE history_sync_runs SET projection='BLOCKED',last_error=$3 WHERE organization_id=$1 AND id=$2",[scope.organizationId,run,code]);
      });
    },
    async claimProjection(raw:HistorySyncScope,run:string,now:Date):Promise<HistoryProjectionClaim|{kind:'IDLE'}> {
      const scope=HistorySyncScopeSchema.parse(raw);
      if(!Number.isFinite(now.getTime()))fail('HISTORY_SYNC_CLOCK_INVALID');
      return options.transact(scope.organizationId,async tx=>{
        const authority=await fence(tx,scope,run);
        const row=(await tx.query<Row>(`SELECT * FROM history_sync_deliveries WHERE organization_id=$1 AND run_id=$2
          AND state IN('PENDING','WAITING_MEDIA') AND next_attempt_at<=$3 AND (lease_until IS NULL OR lease_until<$3)
          ORDER BY chunk_id,record_index FOR UPDATE SKIP LOCKED LIMIT 1`,[scope.organizationId,run,now])).rows[0];
        if(!row){await complete(tx,scope,run);return {kind:'IDLE'};}
        unchanged(row,authority);
        let fact=await record(tx,scope,run,row.chunk_id,row.record_index,now);
        if(fact.kind!=='CHAT' && fact.kind!=='MESSAGE')fail('HISTORY_SYNC_PROJECTION_RECORD_INVALID');
        const peer=(await tx.query<{conversation_id:string;contact_id:string|null;bootstrap_name:string;bootstrap_occurred_at:string}>(`SELECT n.conversation_id,n.contact_id,n.bootstrap_name,n.bootstrap_occurred_at
          FROM history_sync_native_peers n JOIN history_sync_peers p ON p.organization_id=n.organization_id AND p.channel_id=n.channel_id
          AND p.history_account_identity=n.history_account_identity AND p.recipient_kind=n.recipient_kind AND p.peer_jid=n.chat_jid
          WHERE n.organization_id=$1 AND n.channel_id=$2 AND n.history_account_identity=$3 AND n.recipient_kind=$4 AND n.chat_jid=$5`,
        [scope.organizationId,scope.channelId,scope.historyAccountIdentity,fact.recipientKind,normalizeHistoryJid(fact.chatJid)])).rows[0];
        if(!peer)fail('HISTORY_SYNC_PEER_UNPROVEN');
        const mapped=(await tx.query<{remote_conversation_id:string}>(`SELECT remote_conversation_id FROM chatwoot_conversations
          WHERE organization_id=$1 AND integration_id=$2 AND conversation_id=$3`,[scope.organizationId,authority.destination.integrationId,peer.conversation_id])).rows[0];
        if(mapped) {
          const proved=(await tx.query(`SELECT 1 FROM chatwoot_attendance_controls WHERE organization_id=$1 AND integration_id=$2 AND conversation_id=$3
            AND destination_revision=$4 AND account_id=$5 AND inbox_id=$6 AND remote_conversation_id=$7
            UNION ALL SELECT 1 FROM history_sync_remote_peers WHERE organization_id=$1 AND integration_id=$2 AND conversation_id=$3
            AND destination_revision=$4 AND account_id=$5 AND inbox_id=$6 AND receipt->>'conversation_id'=$7::text LIMIT 1`,
          [scope.organizationId,authority.destination.integrationId,peer.conversation_id,authority.destination.destinationRevision,
            authority.destination.accountId,authority.destination.inboxId,mapped.remote_conversation_id])).rowCount;
          if(!proved)fail('HISTORY_SYNC_LIVE_MAP_UNPROVEN');
        }
        await tx.query(`INSERT INTO history_sync_remote_peers(organization_id,channel_id,history_account_identity,integration_id,destination_revision,
          account_id,inbox_id,conversation_id,existing_conversation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,
          (SELECT remote_conversation_id FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$4 AND conversation_id=$8))
          ON CONFLICT(organization_id,integration_id,destination_revision,conversation_id) DO NOTHING`,[scope.organizationId,scope.channelId,scope.historyAccountIdentity,
        authority.destination.integrationId,authority.destination.destinationRevision,authority.destination.accountId,authority.destination.inboxId,peer.conversation_id]);
        const remote=(await tx.query<{id:string;existing_conversation_id:string|null;receipt:HistoryConsumerReceipt|null;account_id:string;inbox_id:string}>(`SELECT * FROM history_sync_remote_peers
          WHERE organization_id=$1 AND integration_id=$2 AND destination_revision=$3 AND conversation_id=$4 FOR UPDATE`,[scope.organizationId,authority.destination.integrationId,
        authority.destination.destinationRevision,peer.conversation_id])).rows[0]!;
        if(Number(remote.account_id)!==authority.destination.accountId || Number(remote.inbox_id)!==authority.destination.inboxId)fail('HISTORY_SYNC_DESTINATION_CHANGED');
        const result=(await tx.query<{message_id:string|null}>('SELECT message_id FROM history_sync_record_results WHERE organization_id=$1 AND run_id=$2 AND chunk_id=$3 AND record_index=$4',
          [scope.organizationId,run,row.chunk_id,row.record_index])).rows[0]!;
        if(fact.kind==='MESSAGE' && fact.content.type==='MEDIA') {
          const canonical=(await tx.query<{content:MessageContent}>(`SELECT content FROM messaging_messages
            WHERE organization_id=$1 AND channel_id=$2 AND id=$3`,[scope.organizationId,scope.channelId,result.message_id])).rows[0]?.content;
          if(canonical?.type!=='MEDIA')fail('HISTORY_SYNC_CANONICAL_MESSAGE_MISSING');
          // Repeated captures may reference a second verified copy of the same
          // bytes. Keep the original object in the consumer's immutable request
          // so a lost ACK/reconnection cannot manufacture a conflicting import.
          fact={...fact,content:{...fact.content,referenceId:canonical.mediaId}};
        }
        const lease=randomUUID();
        await tx.query(`UPDATE history_sync_deliveries SET destination=$3,authority_fingerprint=$4,attempts=attempts+1,lease_token=$5,lease_until=$6
          WHERE organization_id=$1 AND id=$2`,[scope.organizationId,row.id,JSON.stringify(authority.destination),authority.authorityFingerprint,lease,new Date(now.getTime()+120000)]);
        return {kind:'CLAIMED',id:row.id,lease,authority,record:fact,conversationId:peer.conversation_id,contactId:peer.contact_id??peer.conversation_id,
          messageId:result.message_id,displayName:peer.bootstrap_name,bootstrapOccurredAt:Number(peer.bootstrap_occurred_at),receipt:row.receipt,
          remotePeerId:remote.id,existingConversationId:remote.existing_conversation_id===null?null:Number(remote.existing_conversation_id),bootstrapReceipt:remote.receipt};
      });
    },
    async saveProjectionBootstrap(raw:HistorySyncScope,run:string,claim:HistoryProjectionClaim,receipt:HistoryConsumerReceipt) {
      const scope=HistorySyncScopeSchema.parse(raw);
      await options.transact(scope.organizationId,async tx=>{
        const a=await fence(tx,scope,run);
        const row=(await tx.query<Row>('SELECT * FROM history_sync_deliveries WHERE organization_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',
          [scope.organizationId,run,claim.id])).rows[0];
        if(!row || row.lease_token!==claim.lease)fail('HISTORY_SYNC_LEASE_CHANGED');
        unchanged(row,a);
        if(receipt.broker_message_id!==null || receipt.broker_conversation_id!==claim.conversationId || receipt.state!=='PERSISTED')fail('HISTORY_SYNC_RECEIPT_CONFLICT');
        await tx.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,integration_id,conversation_id) DO NOTHING`,
        [scope.organizationId,a.destination.integrationId,claim.conversationId,receipt.contact_id,receipt.source_id,receipt.conversation_id]);
        const map=(await tx.query<{contact_id:string;source_id:string;remote_conversation_id:string}>(`SELECT contact_id,source_id,remote_conversation_id
          FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2 AND conversation_id=$3`,[scope.organizationId,a.destination.integrationId,claim.conversationId])).rows[0]!;
        if(Number(map.contact_id)!==receipt.contact_id || map.source_id!==receipt.source_id || Number(map.remote_conversation_id)!==receipt.conversation_id)fail('HISTORY_SYNC_MAP_CONFLICT');
        await tx.query(`UPDATE history_sync_remote_peers SET receipt=$3 WHERE organization_id=$1 AND id=$2 AND (receipt IS NULL OR receipt=$3::jsonb)`,
          [scope.organizationId,claim.remotePeerId,JSON.stringify(receipt)]).then(result=>{if(!result.rowCount)fail('HISTORY_SYNC_RECEIPT_CONFLICT');});
      });
    },
    async finishProjection(raw:HistorySyncScope,run:string,claim:HistoryProjectionClaim,receipt:HistoryConsumerReceipt|undefined,now:Date) {
      const scope=HistorySyncScopeSchema.parse(raw);
      return options.transact(scope.organizationId,async tx=>{
        const authority=await fence(tx,scope,run);
        const row=(await tx.query<Row>('SELECT * FROM history_sync_deliveries WHERE organization_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',
          [scope.organizationId,run,claim.id])).rows[0];
        if(!row || row.lease_token!==claim.lease)fail('HISTORY_SYNC_LEASE_CHANGED');
        unchanged(row,authority);
        if(!receipt)fail('HISTORY_SYNC_RECEIPT_REQUIRED');
        if(receipt.broker_message_id!==null && receipt.message_id!==null) {
          await tx.query(`INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,$4)
            ON CONFLICT(organization_id,integration_id,message_id) DO NOTHING`,[scope.organizationId,authority.destination.integrationId,claim.messageId,receipt.message_id]);
          const mapped=(await tx.query<{remote_message_id:string}>('SELECT remote_message_id FROM chatwoot_messages WHERE organization_id=$1 AND integration_id=$2 AND message_id=$3',
            [scope.organizationId,authority.destination.integrationId,claim.messageId])).rows[0];
          if(Number(mapped?.remote_message_id)!==receipt.message_id)fail('HISTORY_SYNC_MAP_CONFLICT');
        }
        await tx.query(`UPDATE history_sync_deliveries SET receipt=$3,state=$4,lease_token=NULL,lease_until=NULL,last_error=NULL,next_attempt_at=$5
          WHERE organization_id=$1 AND id=$2`,[scope.organizationId,claim.id,JSON.stringify(receipt),receipt.state==='PERSISTED'?'DONE':'WAITING_MEDIA',new Date(now.getTime()+5000)]);
        if(receipt.state==='PERSISTED' && claim.messageId)await tx.query(`UPDATE integration_jobs SET status='SUCCEEDED',lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
          WHERE organization_id=$1 AND integration_id=$2 AND message_id=$3 AND kind='MIRROR_MESSAGE' AND payload->>'historySyncVersion'='2'`,
        [scope.organizationId,authority.destination.integrationId,claim.messageId]);
        await complete(tx,scope,run);
      });
    },
    async retryProjection(raw:HistorySyncScope,run:string,claim:HistoryProjectionClaim,now:Date,code='HISTORY_CONSUMER_RETRY') {
      if(!/^(HISTORY_CONSUMER_(RETRY|MEDIA_ACK_MISMATCH|RECEIPT_MISMATCH)|HISTORY_SQL_[0-9A-Z]{5}|HISTORY_SYNC_(SCOPE_CHANGED|LEASE_CHANGED|MAP_CONFLICT|RECEIPT_CONFLICT|NOT_RUNNING|DESTINATION_CHANGED)|CHATWOOT_(UNAVAILABLE|REQUEST_REJECTED|OUTCOME_UNKNOWN|INVALID_RESPONSE)(_[1-5][0-9]{2})?)$/u.test(code))fail('HISTORY_SYNC_RETRY_CODE_INVALID');
      const scope=HistorySyncScopeSchema.parse(raw);
      await options.transact(scope.organizationId,async tx=>{
        const authority=await fence(tx,scope,run);
        const row=(await tx.query<Row>('SELECT * FROM history_sync_deliveries WHERE organization_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',
          [scope.organizationId,run,claim.id])).rows[0];
        if(!row || row.lease_token!==claim.lease)fail('HISTORY_SYNC_LEASE_CHANGED');
        unchanged(row,authority);
        await tx.query(`UPDATE history_sync_deliveries SET lease_token=NULL,lease_until=NULL,last_error=$4,next_attempt_at=$3
          WHERE organization_id=$1 AND id=$2`,[scope.organizationId,claim.id,new Date(now.getTime()+Math.min(300000,1000*2**Math.min(row.attempts,8))),code]);
      });
    },
  };
}
