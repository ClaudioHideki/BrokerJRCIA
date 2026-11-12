import { randomUUID } from 'node:crypto';
import { expect,it,vi } from 'vitest';
import { createHistorySyncProjector } from '../../src/modules/history-sync/projector.js';
import type { HistoryProjectionClaim } from '../../src/modules/history-sync/delivery-store.js';
import type { HistorySyncScope } from '../../src/modules/history-sync/contract.js';
import { createHistoryConsumer } from '../../src/modules/history-sync/consumer.js';

const scope:HistorySyncScope={organizationId:randomUUID(),channelId:randomUUID(),instanceId:randomUUID(),engineId:'synthetic',engineGeneration:1,
  sessionGeneration:randomUUID(),bindingFingerprint:'a'.repeat(64),identityScopeId:randomUUID(),historyAccountIdentity:randomUUID(),ownerFingerprint:'b'.repeat(64)};
const destination={organizationId:scope.organizationId,channelId:scope.channelId,instanceId:scope.instanceId,historyAccountIdentity:scope.historyAccountIdentity!,
  integrationId:randomUUID(),accountId:1,inboxId:2,destinationRevision:1};
const base={protocol:'jrc-history-sync/2' as const,account_id:1,inbox_id:2,organization_id:scope.organizationId,integration_id:destination.integrationId,
  history_account_identity:scope.historyAccountIdentity!,destination_revision:1};
const ack={...base,receipt_id:randomUUID(),request_hash:'c'.repeat(64),state:'PERSISTED' as const,conversation_id:3,contact_id:4,source_id:'synthetic',
  broker_conversation_id:randomUUID(),broker_message_id:randomUUID(),message_id:5};
function claim() {
  return {kind:'CLAIMED' as const,id:randomUUID(),lease:randomUUID(),authority:{destination,authorityFingerprint:'d'.repeat(64)},
    conversationId:ack.broker_conversation_id,contactId:randomUUID(),messageId:ack.broker_message_id,displayName:'Synthetic',bootstrapOccurredAt:1,
    remotePeerId:randomUUID(),existingConversationId:null,bootstrapReceipt:null,
    record:{kind:'MESSAGE' as const,recipientKind:'INDIVIDUAL' as const,chatJid:'15555550101@s.whatsapp.net',providerMessageId:'synthetic',
      participantJid:null,fromMe:false,displayName:null,messageTimestamp:100,state:'DELIVERED' as const,content:{type:'TEXT' as const,text:'Synthetic'}},receipt:null};
}
function harness(current:ReturnType<typeof claim>|HistoryProjectionClaim) {
  const consumer={...createHistoryConsumer(async()=>{throw Error('No real HTTP');}),
    capability:vi.fn(async()=>({...base,supports_text:true,supports_groups:true,supports_media:true,supports_silent_bootstrap:true,max_media_bytes:16777216})),
    bootstrap:vi.fn(async()=>({...ack,broker_message_id:null,message_id:null})),message:vi.fn(async()=>ack),
    upload:vi.fn(async()=>({protocol:'jrc-history-sync/2' as const,reference_id:randomUUID(),state:'STORED' as const,sha256:'b'.repeat(64)})),
    receipt:vi.fn(async()=>ack)};
  const store={claimProjection:vi.fn(async()=>current),saveProjectionBootstrap:vi.fn(async()=>{}),finishProjection:vi.fn(async()=>{}),retryProjection:vi.fn(async()=>{}),blockProjection:vi.fn(async()=>{})};
  const media=vi.fn(async()=>Buffer.from('synthetic-bytes'));
  return {consumer,store,media,projector:createHistorySyncProjector({store,consumer:()=>consumer,media})};
}
it('uses the immutable peer bootstrap date for messages with different original timestamps',async()=>{
  const current=claim(),h=harness(current),now=new Date();
  await h.projector.runOnce(scope,randomUUID(),now);
  current.record.messageTimestamp=101;
  await h.projector.runOnce(scope,randomUUID(),now);
  expect(h.consumer.bootstrap.mock.calls.map(args=>args[1].occurredAt)).toEqual([1,1]);
});
it('repairs the same immutable upload before polling a pending media receipt',async()=>{
  const mediaId=randomUUID(),current:HistoryProjectionClaim={...claim(),record:{...claim().record,
    content:{type:'MEDIA',referenceId:mediaId,mediaType:'IMAGE',byteSize:15,sha256:'b'.repeat(64),mimeType:'image/png',filename:'synthetic.png',caption:'Synthetic'}},
    receipt:{...ack,state:'MEDIA_PENDING'}};
  const h=harness(current);
  await h.projector.runOnce(scope,randomUUID(),new Date());
  expect(h.media).toHaveBeenCalledWith(scope,mediaId);
  expect(h.consumer.upload).toHaveBeenCalledOnce();
  expect(h.consumer.receipt).toHaveBeenCalledOnce();
});
it('records an unsupported receiver as a permanent blocked obligation instead of retrying or sending live',async()=>{
  const current=claim(),h=harness(current),run=randomUUID(),now=new Date();
  h.consumer.capability.mockResolvedValue({...base,supports_text:false,supports_groups:false,supports_media:false,supports_silent_bootstrap:false,max_media_bytes:16777216});
  expect(await h.projector.runOnce(scope,run,now)).toEqual({kind:'BLOCKED'});
  expect(h.store.blockProjection).toHaveBeenCalledWith(scope,run,current,'HISTORY_CONSUMER_UNSUPPORTED');
  expect(h.store.retryProjection).not.toHaveBeenCalled();
  expect(h.consumer.message).not.toHaveBeenCalled();
});
