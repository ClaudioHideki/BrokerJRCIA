import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { HistorySyncRecord, HistorySyncScope } from './contract.js';

/** Catalogue facts only. No phone is invented for a LID or group; aliases require
 * independent source proof before native contacts/messages can be materialized.
 * Caller holds the run lock and source authority fence through COMMIT.
 */
export async function catalogueHistoryRecords(tx: TenantTransaction, scope: HistorySyncScope, records: HistorySyncRecord[], now: Date) {
  if (!scope.historyAccountIdentity) throw Error('HISTORY_SYNC_IDENTITY_REQUIRED');
  const peers = new Map<string,{ kind: 'INDIVIDUAL'|'GROUP'; jid: string; name: string|null; latest: number|null; chat: boolean }>();
  for (const record of records) {
    if (record.kind === 'GAP') continue;
    const jid = (record.kind === 'CONTACT' ? record.jid : record.chatJid).replace(/:\d+(?=@)/u,'');
    const kind = record.kind === 'CONTACT' ? 'INDIVIDUAL' : record.recipientKind;
    const isChat = record.kind !== 'CONTACT';
    const stamp = record.kind === 'CHAT' ? record.lastMessageAt : record.kind === 'MESSAGE' ? record.messageTimestamp : null;
    // MESSAGE.displayName is pushName (sender), not a group subject or outbound recipient.
    const displayName = record.kind === 'MESSAGE' ? null : record.displayName?.trim() || null;
    const key = `${kind}:${jid}`, previous = peers.get(key);
    peers.set(key,{ kind,jid,name: previous?.name ?? displayName,
      latest: stamp === null ? previous?.latest ?? null : Math.max(stamp,previous?.latest ?? 0), chat: isChat || previous?.chat === true });
  }
  // Deterministic order also avoids reverse-order row-lock acquisition across runs.
  for (const peer of [...peers.values()].sort((a,b)=>`${a.kind}:${a.jid}`.localeCompare(`${b.kind}:${b.jid}`))) {
    await tx.query(`INSERT INTO history_sync_peers(organization_id,channel_id,history_account_identity,recipient_kind,peer_jid,
      display_name,last_message_at,discovered_as_chat,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
      ON CONFLICT(organization_id,channel_id,history_account_identity,recipient_kind,peer_jid) DO UPDATE SET
       display_name=COALESCE(NULLIF(btrim(history_sync_peers.display_name),''),EXCLUDED.display_name),
       last_message_at=GREATEST(history_sync_peers.last_message_at,EXCLUDED.last_message_at),
       discovered_as_chat=history_sync_peers.discovered_as_chat OR EXCLUDED.discovered_as_chat,updated_at=EXCLUDED.updated_at`,
    [scope.organizationId,scope.channelId,scope.historyAccountIdentity,peer.kind,peer.jid,peer.name,peer.latest,peer.chat,now]);
  }
  return { peers: peers.size, chats: [...peers.values()].filter(value=>value.chat).length };
}
