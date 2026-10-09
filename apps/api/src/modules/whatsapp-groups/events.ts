import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { QrGroupEvent } from '../messaging/qr-group-events.js';
import { createHmac, randomUUID } from 'node:crypto';
import { lockAttendanceChannel } from '../attendance/repository.js';

class GroupEventError extends Error {
  readonly status = 404; readonly code = 'GROUP_CHANNEL_NOT_FOUND';
  constructor() { super('GROUP_CHANNEL_NOT_FOUND'); }
}
interface Scope { identity_revision: string; identity_fingerprint: string | null; last_error_code: string | null; snapshot_id: string | null }
async function lockScope(tx: TenantTransaction, org: string, channel: string, requireConnected = true): Promise<Scope | undefined> {
  // Same inbound policy as resolve_qr_channel: suspension is not deletion.
  // Channel write triggers still fence durable lifecycle requests.
  try { await lockAttendanceChannel(tx, org, channel); }
  catch (error) { if ((error as { code?: unknown })?.code === 'CHANNEL_NOT_FOUND') throw new GroupEventError(); throw error; }
  const row = (await tx.query(`SELECT c.id FROM messaging_channels c JOIN instances i
    ON i.organization_id=c.organization_id AND i.id=c.instance_id WHERE c.organization_id=$1 AND c.id=$2
    AND c.provider='BAILEYS' AND c.deleting_at IS NULL AND i.archived_at IS NULL
    AND (NOT $3::boolean OR i.status='CONNECTED')`, [org, channel, requireConnected])).rows[0];
  if (!row) throw new GroupEventError();
  return (await tx.query<Scope>('SELECT identity_revision,identity_fingerprint,last_error_code,snapshot_id FROM whatsapp_group_catalogs WHERE organization_id=$1 AND channel_id=$2 FOR UPDATE', [org, channel])).rows[0];
}
/** A successful independent whole-catalog read is the only path which asserts
 * current participation. Webhook ADD/UPSERT is an observation, never a grant.
 */
export async function reconcileWhatsAppGroupParticipation(tx: TenantTransaction, org: string, channel: string) {
  await tx.query(`INSERT INTO whatsapp_group_participation(organization_id,channel_id,identity_revision,identity_fingerprint,group_jid,own_state,source_snapshot_id)
    SELECT c.organization_id,c.channel_id,c.identity_revision,c.identity_fingerprint,i.group_jid,'PRESENT_FROM_CATALOG',c.snapshot_id
    FROM whatsapp_group_catalogs c JOIN whatsapp_group_catalog_items i ON i.organization_id=c.organization_id AND i.channel_id=c.channel_id
    WHERE c.organization_id=$1 AND c.channel_id=$2 AND c.snapshot_id IS NOT NULL AND c.last_error_code IS NULL
    ON CONFLICT(organization_id,channel_id,identity_revision,group_jid) DO UPDATE SET
    identity_fingerprint=EXCLUDED.identity_fingerprint,own_state=EXCLUDED.own_state,source_snapshot_id=EXCLUDED.source_snapshot_id,last_event_id=NULL,updated_at=clock_timestamp()`, [org, channel]);
}
export function createWhatsAppGroupEvents(options: { encryptionKey: string }) {
  const key = Buffer.from(options.encryptionKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== options.encryptionKey) throw new Error('INVALID_INTEGRATION_ENCRYPTION_KEY');
  const fingerprint = (org: string, channel: string, phone: string) => createHmac('sha256', key)
    .update(`whatsapp-group-identity:v1:${org}:${channel}:${phone}`).digest('hex');
  return {
    async ingest(tx: TenantTransaction, org: string, channel: string, events: QrGroupEvent[]) {
      if (events.length === 0) return { accepted: 0, duplicates: 0, ignored: 0 };
      const scope = await lockScope(tx, org, channel);
      const result = { accepted: 0, duplicates: 0, ignored: 0 };
      for (const event of events) {
        const phone = /^([1-9]\d{6,14})@s\.whatsapp\.net$/u.exec(event.senderJid)?.[1];
        if (!scope?.snapshot_id || !scope.identity_fingerprint || !phone || scope.last_error_code === 'IDENTITY_CHANGED'
          || fingerprint(org, channel, phone) !== scope.identity_fingerprint) { result.ignored++; continue; }
        const participants = [...event.participants].sort();
        const eventKey = createHmac('sha256', key).update('whatsapp-group-event:v1\0').update(JSON.stringify({
          organizationId: org, channelId: channel, identityRevision: scope.identity_revision, identityFingerprint: scope.identity_fingerprint,
          action: event.action, groupJid: event.groupJid, providerEmittedAt: event.providerEmittedAt,
          authorJid: event.authorJid, participants, metadata: event.metadata,
        })).digest('hex');
        const containsSelf = participants.includes(`${phone}@s.whatsapp.net`);
        const ownEffect = containsSelf && event.action === 'REMOVE' ? 'REMOVAL_OBSERVED'
          : containsSelf && ['ADD', 'UPSERT'].includes(event.action) ? 'ADD_OBSERVED' : 'UNVERIFIED';
        const id = randomUUID();
        const inserted = await tx.query(`INSERT INTO whatsapp_group_events(organization_id,channel_id,id,identity_revision,identity_fingerprint,
          event_key,group_jid,event_kind,provider_emitted_at,author_jid,participants,metadata,own_number_effect)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13) ON CONFLICT(organization_id,channel_id,identity_revision,event_key) DO NOTHING RETURNING id`,
          [org, channel, id, scope.identity_revision, scope.identity_fingerprint, eventKey, event.groupJid, event.action,
            event.providerEmittedAt, event.authorJid, JSON.stringify(participants), JSON.stringify(event.metadata), ownEffect]);
        if (!inserted.rowCount) { result.duplicates++; continue; }
        result.accepted++;
        const ownState = ownEffect === 'REMOVAL_OBSERVED' ? 'REMOVAL_OBSERVED' : 'UNVERIFIED';
        await tx.query(`INSERT INTO whatsapp_group_participation(organization_id,channel_id,identity_revision,identity_fingerprint,group_jid,own_state,last_event_id)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,channel_id,identity_revision,group_jid) DO UPDATE SET
          own_state=CASE WHEN whatsapp_group_participation.own_state='REMOVAL_OBSERVED' THEN 'REMOVAL_OBSERVED' ELSE EXCLUDED.own_state END,
          source_snapshot_id=NULL,last_event_id=CASE WHEN whatsapp_group_participation.own_state='REMOVAL_OBSERVED'
            THEN whatsapp_group_participation.last_event_id ELSE EXCLUDED.last_event_id END,updated_at=clock_timestamp()`,
          [org, channel, scope.identity_revision, scope.identity_fingerprint, event.groupJid, ownState, id]);
        if (participants.length && event.action !== 'UPDATE') await tx.query(`INSERT INTO whatsapp_group_participants(organization_id,channel_id,identity_revision,identity_fingerprint,
          group_jid,participant_jid,last_action,last_event_id) SELECT $1,$2,$3,$4,$5,x,$6,$7 FROM unnest($8::text[]) AS x
          ON CONFLICT(organization_id,channel_id,identity_revision,group_jid,participant_jid) DO UPDATE SET last_action=EXCLUDED.last_action,last_event_id=EXCLUDED.last_event_id,observed_at=clock_timestamp()`,
          [org, channel, scope.identity_revision, scope.identity_fingerprint, event.groupJid, event.action, id, participants]);
        // Cancelling the read lease prevents a pre-event catalog result from
        // restoring selections after a removal. Fresh catalog reconciliation is
        // required; neither provider time nor a delayed ADD claims causality.
        await tx.query(`UPDATE whatsapp_group_catalogs SET last_error_code=$3,lease_token=NULL,lease_expires_at=NULL,
          catalog_revision=catalog_revision+1,updated_at=clock_timestamp() WHERE organization_id=$1 AND channel_id=$2`,
          [org, channel, ['UPSERT', 'UPDATE'].includes(event.action) ? 'GROUP_METADATA_CHANGED' : 'GROUP_MEMBERSHIP_CHANGED']);
        if (event.action === 'REMOVE' && (containsSelf || participants.some(jid => jid.endsWith('@lid')))) {
          await tx.query('UPDATE whatsapp_group_catalog_items SET selected=false WHERE organization_id=$1 AND channel_id=$2 AND group_jid=$3', [org, channel, event.groupJid]);
        }
      }
      return result;
    },
    async observeConnection(tx: TenantTransaction, org: string, channel: string, state: { connected: boolean; phone: string | null }) {
      // The caller processes this before updating the physical instance state.
      const scope = await lockScope(tx, org, channel, false);
      if (!scope?.identity_fingerprint) return;
      const current = state.connected && state.phone && /^[1-9]\d{6,14}$/u.test(state.phone) ? fingerprint(org, channel, state.phone) : null;
      if (current === scope.identity_fingerprint) return;
      await tx.query(`UPDATE whatsapp_group_catalogs SET last_error_code='IDENTITY_CHANGED',lease_token=NULL,lease_expires_at=NULL,
        catalog_revision=catalog_revision+1,updated_at=clock_timestamp() WHERE organization_id=$1 AND channel_id=$2`, [org, channel]);
      await tx.query('UPDATE whatsapp_group_catalog_items SET selected=false WHERE organization_id=$1 AND channel_id=$2', [org, channel]);
    },
  };
}
