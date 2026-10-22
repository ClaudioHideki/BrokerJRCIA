import { createHash, randomUUID } from 'node:crypto';
import { PartnerTextRequestSchema, type PartnerTextRequest, type MessageView } from '@jrc/contracts';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import type { MessagingRepository } from './repository.js';
import { requireActiveOrganization } from '../tenancy/operational-limits.js';
import { recordManualAttendanceTakeover } from '../attendance/manual-takeover.js';
import { lockAttendanceChannel } from '../attendance/repository.js';

function unavailable(code: string, status: number) {
  return Object.assign(new Error(code), { code, status, statusCode: status });
}
/** Public partner sends use the private messaging outbox, never a provider URL. */
export function createPartnerTextSender(options: {
  repository: MessagingRepository;
  transact<T>(organizationId: string, operation: OrganizationTransaction<T>): Promise<T>;
}) {
  return async (organizationId: string, channelId: string, raw: PartnerTextRequest,
    idempotencyKey: string, apiKeyId: string): Promise<MessageView & {conversationId:string}> => {
    const input = PartnerTextRequestSchema.parse(raw);
    return options.transact(organizationId, async tx => {
      await requireActiveOrganization(tx, organizationId);
      const activeKey = await tx.query(`SELECT id FROM api_keys WHERE organization_id=$1 AND id=$2
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())
        AND scopes @> ARRAY['messaging:send']::text[] FOR SHARE`, [organizationId, apiKeyId]);
      if (!activeKey.rows.length) throw unavailable('PARTNER_CREDENTIAL_REVOKED', 403);
      const channel = await options.repository.findChannel(tx, organizationId, channelId);
      if (!channel || channel.organizationId !== organizationId) throw unavailable('CHANNEL_NOT_FOUND', 404);
      if (channel.transport !== 'BROKER_TRANSPORT') throw unavailable('BROKER_CHANNEL_REQUIRED', 422);
      // First-contact free text is a QR capability. Meta requires its approved
      // template journey; do not accept a request that the worker cannot send.
      if (channel.provider !== 'BAILEYS') throw unavailable('PARTNER_QR_CHANNEL_REQUIRED', 422);
      // Inbound admission locks channel before contact/conversation rows. Keep
      // the same order, including the initial-recipient path, to avoid cycles.
      await lockAttendanceChannel(tx, organizationId, channelId);
      const bodyHash = createHash('sha256').update(JSON.stringify({apiKeyId, input})).digest('hex');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['partner-text',organizationId,channelId,idempotencyKey])]);
      const existing = (await tx.query<{id:string;conversationId:string;state:MessageView['state'];bodyHash:string;text:string}>(
        `SELECT id,conversation_id AS "conversationId",state,idempotency_body_hash AS "bodyHash",content->>'text' AS text
         FROM messaging_messages WHERE organization_id=$1 AND channel_id=$2 AND idempotency_key=$3`,
        [organizationId,channelId,idempotencyKey])).rows[0];
      if (existing) {
        if (existing.bodyHash !== bodyHash) throw unavailable('IDEMPOTENCY_CONFLICT',409);
        return {id:existing.id,conversationId:existing.conversationId,direction:'OUTGOING',state:existing.state,text:existing.text};
      }
      let conversationId: string;
      if ('conversationId' in input) {
        const conversation = await options.repository.findConversation(tx, organizationId, input.conversationId);
        if (!conversation || conversation.organizationId !== organizationId || conversation.channelId !== channelId)
          throw unavailable('CONVERSATION_NOT_FOUND', 404);
        conversationId = conversation.id;
      } else {
        const contact = await options.repository.upsertContact(tx, { id: randomUUID(), organizationId,
          externalId: input.phoneNumber.slice(1), displayName: null, consentStatus: 'UNKNOWN', consentUpdatedAt: null });
        const conversation = await options.repository.getOrCreateConversation(tx, { id: randomUUID(), organizationId,
          channelId, contactId: contact.id });
        conversationId = conversation.id;
      }
      await recordManualAttendanceTakeover(tx, organizationId, conversationId);
      await options.repository.setConversationMode(tx, { organizationId, conversationId, mode: 'HUMAN' });
      const content = { type: 'TEXT' as const, text: input.text };
      const result = await options.repository.enqueueOutgoing(tx, { id: randomUUID(), organizationId, channelId,
        conversationId, source: 'OPERATOR', content, idempotencyKey, authorizingApiKeyId: apiKeyId,
        bodyHash,
        policy: { requireOptIn: false } });
      return { id: result.message.id, conversationId, direction: result.message.direction, state: result.message.state, text: input.text };
    });
  };
}
