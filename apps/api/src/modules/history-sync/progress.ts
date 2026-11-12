import { HistorySyncStatusSchema,HistorySyncProgressSchema } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';

export async function readLatestHistorySyncProgress(tx:TenantTransaction,org:string,channel:string) {
  const latest=(await tx.query<{id:string}>(`SELECT id FROM history_sync_runs WHERE organization_id=$1 AND channel_id=$2
    ORDER BY created_at DESC,id DESC LIMIT 1`,[org,channel])).rows[0];
  return HistorySyncProgressSchema.parse({schemaVersion:2,organizationId:org,channelId:channel,
    run:latest?await readHistorySyncProgress(tx,org,channel,latest.id):null});
}

/** Status is committed-page metadata, never a phone coverage proof. No page is
 * decrypted and no credential, source fingerprint or message leaves this query. */
export async function readHistorySyncProgress(tx:TenantTransaction,org:string,channel:string,run:string) {
  const row=(await tx.query<Record<string,string|boolean|null>>(`SELECT r.id,r.organization_id,r.channel_id,r.instance_id,r.revision,
    r.state,r.capture,r.persistence,r.projection,r.source_total_known,r.last_error,r.chats,r.captured_messages,
    r.persisted_messages,r.duplicate_messages,r.projected_messages,r.pending_media,r.verified_media,r.unavailable_media,r.blocked_records,
    media.pending AS remote_pending_media,media.copied AS copied_media,
    (SELECT count(DISTINCT (s.recipient_kind,s.peer_jid)) FROM history_sync_record_results s
      WHERE s.organization_id=r.organization_id AND s.run_id=r.id AND s.peer_jid IS NOT NULL AND s.disposition NOT IN('BLOCKED','GAP'))::text AS processed_chats,
    (SELECT count(*) FROM history_sync_record_results s WHERE s.organization_id=r.organization_id AND s.run_id=r.id
      AND s.safe_code='MEDIA_UNAVAILABLE')::text AS unavailable_media_records
    FROM history_sync_runs r CROSS JOIN LATERAL (
      SELECT count(*) FILTER(WHERE d.state<>'DONE')::text AS pending,count(*) FILTER(WHERE d.state='DONE')::text AS copied
      FROM history_sync_record_results s JOIN messaging_messages m ON m.organization_id=s.organization_id AND m.id=s.message_id
      JOIN history_sync_deliveries d ON d.organization_id=s.organization_id AND d.run_id=s.run_id AND d.chunk_id=s.chunk_id AND d.record_index=s.record_index
      WHERE s.organization_id=r.organization_id AND s.run_id=r.id AND m.content->>'type'='MEDIA'
    ) media WHERE r.organization_id=$1 AND r.channel_id=$2 AND r.id=$3`,[org,channel,run])).rows[0];
  if(!row)return null;
  const n=(key:string)=>Number(row[key]);
  return HistorySyncStatusSchema.parse({schemaVersion:2,id:row.id,organizationId:row.organization_id,channelId:row.channel_id,
    instanceId:row.instance_id,revision:n('revision'),state:row.state,capture:row.capture,persistence:row.persistence,projection:row.projection,
    sourceTotalKnown:row.source_total_known,lastError:row.last_error,counts:{chats:n('processed_chats'),capturedMessages:n('captured_messages'),
      persistedMessages:n('persisted_messages'),duplicateMessages:n('duplicate_messages'),projectedMessages:n('projected_messages'),
      pendingMedia:n('pending_media')+n('remote_pending_media'),verifiedMedia:Math.max(n('verified_media'),n('copied_media')),
      unavailableMedia:Math.max(n('unavailable_media'),n('unavailable_media_records')),blockedRecords:n('blocked_records')}});
}
