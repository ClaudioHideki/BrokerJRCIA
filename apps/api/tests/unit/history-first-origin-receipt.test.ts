import { expect, it } from 'vitest';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import type { HistorySyncRecord } from '../../src/modules/history-sync/contract.js';
import { historyFactHash } from '../../src/modules/history-sync/writer.js';
import { assertOriginFactPersisted } from '../../src/modules/messaging/origin-receipt.js';

const scope = { organizationId: 'synthetic-org', channelId: 'synthetic-channel' };
// These are reserved synthetic fixture identities, never customer addresses.
for (const group of [false, true]) for (const outgoing of [false, true]) {
  const peer = group ? '100-200@g.us' : '15555550101@s.whatsapp.net';
  const fact: Extract<HistorySyncRecord, { kind: 'MESSAGE' }> = {
    kind: 'MESSAGE', recipientKind: group ? 'GROUP' : 'INDIVIDUAL', chatJid: peer,
    providerMessageId: 'synthetic-history-first-text', fromMe: outgoing,
    participantJid: group && !outgoing ? '123456789@lid' : null,
    messageTimestamp: 1600000000, displayName: null,
    content: { type: 'TEXT', text: 'Synthetic historical fact' }, state: 'DELIVERED',
  };
  const event = (group ? {
    kind: 'group-text', groupJid: peer, fromMe: outgoing, participantJid: fact.participantJid,
    participantJidAlt: null, content: fact.content, upstreamMessageId: fact.providerMessageId,
    occurredAt: new Date(1600000000000),
  } : {
    kind: outgoing ? 'outbound' : 'message', externalId: peer.split('@')[0], displayName: null,
    content: fact.content, upstreamMessageId: fact.providerMessageId, occurredAt: new Date(1600000000000),
  }) as Parameters<typeof assertOriginFactPersisted>[2];

  for (const corrupted of [false, true]) it(
    `verifies the immutable history receipt before live ACK (group=${group},outgoing=${outgoing},corrupted=${corrupted})`,
    async () => {
      const tx = { query: async (sql: string) => {
        if (sql.includes('SELECT s.scope_id')) return { rows: [{ scope_id: 'synthetic-identity', binding_fingerprint: 'a'.repeat(64) }] };
        if (sql.includes('SELECT DISTINCT r.message_id')) return { rows: [{ message_id: 'synthetic-message',
          content_hash: corrupted ? '0'.repeat(64) : historyFactHash(fact) }] };
        if (sql.includes('FROM messaging_messages m')) return { rows: [{ content: fact.content,
          peer: peer.split('@')[0], occurred_at: event.occurredAt, direction: outgoing ? 'OUTGOING' : 'INCOMING' }] };
        if (sql.includes('FROM qr_outbound_observations o') || sql.includes('FROM whatsapp_group_transport_facts f')) return { rows: [] };
        throw Error('Unexpected fixture read');
      } } as unknown as TenantTransaction;
      const result = assertOriginFactPersisted(tx, scope, event, 2);
      if (corrupted) await expect(result).rejects.toThrow('HISTORY_SYNC_LIVE_FACT_CONFLICT');
      else await expect(result).resolves.toBeUndefined();
    }
  );
}
