import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
import { lockChatwootDestination } from './chatwoot-destination.js';

const positiveId = z.number().int().positive();
const manifestSchema = z.strictObject({
  organizationId: z.uuid(), integrationId: z.uuid(), channelId: z.uuid(), origin: z.url(),
  accountId: positiveId, inboxId: positiveId, destinationRevision: positiveId, credentialRevision: positiveId,
  cutoff: z.iso.datetime(), expectedCount: positiveId.max(10_000),
  jobs: z.array(z.strictObject({ id: z.uuid(), messageId: positiveId, conversationId: positiveId })).min(1).max(10_000),
});

export async function freezeReplyCohort(tx: TenantTransaction, raw: Buffer) {
  const m = manifestSchema.parse(JSON.parse(raw.toString('utf8')));
  const expected = new Map(m.jobs.map(j => [j.id, j]));
  if (m.jobs.length !== m.expectedCount || expected.size !== m.expectedCount ||
      new Set(m.jobs.map(j => j.messageId)).size !== m.expectedCount) throw new Error('REPLY_COHORT_MANIFEST_MISMATCH');
  const digest = createHash('sha256').update(raw).digest('hex');
  const marker = { version: 1, origin: m.origin, accountId: m.accountId, inboxId: m.inboxId, digest };
  await lockChatwootDestination(tx, m.organizationId);
  await lockAttendanceChannel(tx, m.organizationId, m.channelId);
  const scope = await tx.query(`SELECT c.id FROM chatwoot_connections c
    JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
    JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
    WHERE c.organization_id=$1 AND c.id=$2 AND c.channel_id=$3 AND a.base_url=$4
      AND a.account_id=$5 AND c.inbox_id=$6 AND d.revision=$7 AND a.credential_version=$8
      AND d.approval_status='APPROVED' AND $9::timestamptz<=clock_timestamp()
    FOR UPDATE OF c FOR SHARE OF a,d`, [m.organizationId,m.integrationId,m.channelId,m.origin,
    m.accountId,m.inboxId,m.destinationRevision,m.credentialRevision,m.cutoff]);
  if (scope.rowCount !== 1) throw new Error('REPLY_COHORT_SCOPE_CHANGED');
  const params = [m.organizationId,m.integrationId,m.cutoff,m.accountId,m.inboxId,m.destinationRevision,m.channelId,JSON.stringify(marker)];
  const rows = await tx.query<{id:string; safe:boolean; held:boolean; remote:string; conversation:string}>(`
    SELECT j.id,j.payload->>'messageId' AS remote,j.payload->>'conversationId' AS conversation,
      (j.status='PENDING' AND j.lease_token IS NULL AND j.lease_expires_at IS NULL AND j.message_id IS NULL
       AND j.dedupe_key=concat_ws(':','reply',$6::int,$4::bigint,$5::bigint,j.payload->>'messageId')
       AND j.payload->>'destinationRevision'=$6::int::text AND o.id IS NOT NULL
       AND ((NOT (j.payload ? 'frozenReply') AND isfinite(j.available_at))
         OR (j.payload->'frozenReply'=$8::jsonb AND j.available_at='infinity'))) AS safe,
      j.available_at='infinity' AS held
    FROM integration_jobs j LEFT JOIN chatwoot_attendance_observations o
      ON o.organization_id=j.organization_id AND o.integration_id=j.integration_id
      AND o.channel_id=$7 AND o.account_id=$4 AND o.inbox_id=$5 AND o.destination_revision=$6
      AND o.event_key='message:'||(j.payload->>'messageId') AND o.remote_conversation_id::text=j.payload->>'conversationId'
      AND o.id::text=j.payload->>'attendanceObservationId'
    WHERE j.organization_id=$1 AND j.integration_id=$2 AND j.kind='CHATWOOT_REPLY'
      AND (j.status='RUNNING' OR (j.status='PENDING' AND j.created_at<=$3::timestamptz))
    ORDER BY j.id FOR UPDATE OF j`, params);
  if (rows.rowCount !== expected.size || rows.rows.some(row => {
    const job = expected.get(row.id);
    return !row.safe || !job || String(job.messageId)!==row.remote || String(job.conversationId)!==row.conversation;
  })) throw new Error('REPLY_COHORT_STATE_CHANGED');
  const ids = rows.rows.filter(row => !row.held).map(row => row.id);
  if (ids.length) {
    const update = await tx.query(`UPDATE integration_jobs SET available_at='infinity',
      payload=payload||jsonb_build_object('frozenReply',$4::jsonb),updated_at=clock_timestamp()
      WHERE organization_id=$1 AND integration_id=$2 AND id=ANY($3::uuid[])`, [m.organizationId,m.integrationId,ids,JSON.stringify(marker)]);
    if (update.rowCount !== ids.length) throw new Error('REPLY_COHORT_STATE_CHANGED');
    await tx.query(`INSERT INTO integration_audit(organization_id,action,resource_id,reason)
      VALUES($1,'CHATWOOT_REPLY_COHORT_FROZEN',$2,$3)`,[m.organizationId,m.integrationId,`sha256=${digest} count=${ids.length} cutoff=${m.cutoff}`]);
  }
  return { digest, matched: rows.rows.length, changed: ids.length };
}
