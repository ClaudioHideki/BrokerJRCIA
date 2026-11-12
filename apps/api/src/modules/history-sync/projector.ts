import { hashIdempotencyRequest } from '../instances/idempotency.js';
import type { createHistorySyncStore } from './store.js';
import type { createHistoryConsumer, HistoryDestination } from './consumer.js';
import type { HistorySyncScope } from './contract.js';
import { normalizeHistoryJid } from './writer.js';
import { ChatwootError } from '../integrations/chatwoot-client.js';
type Options={
  store:Pick<ReturnType<typeof createHistorySyncStore>,'claimProjection'|'saveProjectionBootstrap'|'finishProjection'|'retryProjection'|'blockProjection'>;
  consumer(destination:HistoryDestination):ReturnType<typeof createHistoryConsumer>;
  /** Physical private read by reference, with the host's current authority fence. No caller URL. */
  media(scope:HistorySyncScope,id:string):Promise<Buffer>;
};
/** Bounded one-record low-priority worker. Every HTTP operation is V2 and
 * idempotent; uncertainty retains its PostgreSQL obligation and KEEP. */
export function createHistorySyncProjector(options:Options) {
  return {async runOnce(scope:HistorySyncScope,run:string,now:Date) {
    const claim=await options.store.claimProjection(scope,run,now);
    if(claim.kind!=='CLAIMED')return claim;
    try {
      const d=claim.authority.destination,consumer=options.consumer(d),fact=claim.record;
      const capability=await consumer.capability(d);
      if(!capability.supports_silent_bootstrap || !capability.supports_text
        || fact.recipientKind==='GROUP'&&!capability.supports_groups
        || fact.kind==='MESSAGE'&&fact.content.type==='MEDIA'&&!capability.supports_media)
        throw Error('HISTORY_CONSUMER_UNSUPPORTED');
      let receipt=claim.receipt;
      if(receipt?.state==='MEDIA_PENDING' && fact.kind==='MESSAGE' && fact.content.type==='MEDIA') {
        await consumer.upload(d,fact.content,await options.media(scope,fact.content.referenceId));
        receipt=await consumer.receipt(d,receipt,fact.content.sha256);
      } else {
        const jid=normalizeHistoryJid(fact.chatJid);
        const recipient={kind:fact.recipientKind,jid,name:claim.displayName??'WhatsApp',
          ...(fact.recipientKind==='GROUP'?{group_scope:hashIdempotencyRequest([scope.organizationId,scope.channelId,scope.historyAccountIdentity,jid])}:{})};
        receipt=claim.bootstrapReceipt??await consumer.bootstrap(d,{brokerContactId:claim.contactId,brokerConversationId:claim.conversationId,recipient,
          occurredAt:claim.bootstrapOccurredAt,conversationId:claim.existingConversationId});
        await options.store.saveProjectionBootstrap(scope,run,claim,receipt);
        if(fact.kind==='MESSAGE') {
          if(!claim.messageId)throw Error('HISTORY_SYNC_CANONICAL_MESSAGE_MISSING');
          if(fact.content.type==='MEDIA') {
            if(fact.content.byteSize>(capability.max_media_bytes??0))throw Error('HISTORY_CONSUMER_MEDIA_LIMIT');
            await consumer.upload(d,fact.content,await options.media(scope,fact.content.referenceId));
          }
          receipt=await consumer.message(d,{brokerConversationId:claim.conversationId,brokerMessageId:claim.messageId,record:fact});
        }
      }
      await options.store.finishProjection(scope,run,claim,receipt,now);
      return {kind:receipt.state==='PERSISTED'?'DONE':'WAITING_MEDIA'} as const;
    } catch (error) {
      if(error instanceof Error && (error.message==='HISTORY_CONSUMER_UNSUPPORTED'||error.message==='HISTORY_CONSUMER_MEDIA_LIMIT')) {
        await options.store.blockProjection(scope,run,claim,error.message);
        return {kind:'BLOCKED'} as const;
      }
      // No raw payload, URL, token or upstream error text is persisted/logged.
      const localCodes=['HISTORY_SYNC_SCOPE_CHANGED','HISTORY_SYNC_LEASE_CHANGED','HISTORY_SYNC_MAP_CONFLICT','HISTORY_SYNC_RECEIPT_CONFLICT',
        'HISTORY_SYNC_NOT_RUNNING','HISTORY_SYNC_DESTINATION_CHANGED','HISTORY_CONSUMER_MEDIA_ACK_MISMATCH','HISTORY_CONSUMER_RECEIPT_MISMATCH'];
      const pgCode=error!==null&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[0-9A-Z]{5}$/u.test(error.code)?error.code:null;
      const known=error instanceof ChatwootError && ['CHATWOOT_UNAVAILABLE','CHATWOOT_REQUEST_REJECTED','CHATWOOT_OUTCOME_UNKNOWN','CHATWOOT_INVALID_RESPONSE'].includes(error.code)
        ?`${error.code}${error.httpStatus?`_${error.httpStatus}`:''}`:error instanceof Error&&localCodes.includes(error.message)?error.message:pgCode?`HISTORY_SQL_${pgCode}`:'HISTORY_CONSUMER_RETRY';
      await options.store.retryProjection(scope,run,claim,now,known);
      return {kind:'RETRY'} as const;
    }
  }};
}
