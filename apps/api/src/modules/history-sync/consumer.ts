import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hashIdempotencyRequest } from '../instances/idempotency.js';
import { HistorySyncRecordSchema,type HistorySyncRecord } from './contract.js';
const uuid=z.uuid(),positive=z.number().int().positive().safe(),sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const HistoryDestinationSchema=z.strictObject({organizationId:uuid,channelId:uuid,integrationId:uuid,instanceId:uuid,
  historyAccountIdentity:uuid,accountId:positive,inboxId:positive,destinationRevision:positive});
export type HistoryDestination=z.infer<typeof HistoryDestinationSchema>;
const envelope={protocol:z.literal('jrc-history-sync/2'),account_id:positive,inbox_id:positive,organization_id:uuid,
  integration_id:uuid,history_account_identity:uuid,destination_revision:positive};
const receiptSchema=z.strictObject({...envelope,receipt_id:uuid,request_hash:sha,state:z.enum(['PERSISTED','MEDIA_PENDING']),
  conversation_id:positive,contact_id:positive,source_id:z.string().min(1).max(512),broker_conversation_id:uuid,
  broker_message_id:uuid.nullable(),message_id:positive.nullable(),media_sha256:sha.optional()});
export type HistoryConsumerReceipt=z.infer<typeof receiptSchema>;
type Request=(method:'GET'|'POST',path:string,body?:unknown)=>Promise<unknown>;
type Fact=Extract<HistorySyncRecord,{kind:'MESSAGE'}>;
type Media=Extract<Fact['content'],{type:'MEDIA'}>;
function invalid(code:string):never {throw Error(code);}
const scope=(d:HistoryDestination)=>({organization_id:d.organizationId,integration_id:d.integrationId,instance_id:d.instanceId,
  destination_revision:d.destinationRevision,history_account_identity:d.historyAccountIdentity});
const base=(d:HistoryDestination)=>`/api/v1/accounts/${d.accountId}/jrc_history_sync/v2/inboxes/${d.inboxId}`;
export function historyConsumerRequestHash(body:Record<string,unknown>) {
  const {status:_status,instance_id:_instance,destination_revision:_revision,...semantic}=body;
  return hashIdempotencyRequest(semantic);
}
const correlated=(d:HistoryDestination,value:z.infer<z.ZodObject<typeof envelope>>)=>value.organization_id===d.organizationId
  && value.integration_id===d.integrationId && value.history_account_identity===d.historyAccountIdentity && value.account_id===d.accountId
  && value.inbox_id===d.inboxId && value.destination_revision===d.destinationRevision;
export function createHistoryConsumer(request:Request) {
  const receipt=(d:HistoryDestination,raw:unknown,expected:{hash:string;conversation:string;message:string|null})=>{
    const parsed=receiptSchema.safeParse(raw);
    if(!parsed.success || !correlated(d,parsed.data) || parsed.data.request_hash!==expected.hash
      || parsed.data.broker_conversation_id!==expected.conversation || parsed.data.broker_message_id!==expected.message
      || (expected.message===null)!==(parsed.data.message_id===null))invalid('HISTORY_CONSUMER_RECEIPT_MISMATCH');
    return parsed.data;
  };
  return {
    async capability(raw:HistoryDestination) {
      const d=HistoryDestinationSchema.parse(raw),query=new URLSearchParams(Object.entries(scope(d)).map(([k,v])=>[k,String(v)] as [string,string]));
      const parsed=z.strictObject({...envelope,supports_text:z.boolean(),supports_groups:z.boolean(),supports_media:z.boolean(),
        supports_silent_bootstrap:z.boolean(),max_media_bytes:positive.max(16*1024*1024).optional()}).safeParse(await request('GET',`${base(d)}?${query}`));
      if(!parsed.success || !correlated(d,parsed.data))invalid('HISTORY_CONSUMER_CAPABILITY_MISMATCH');
      return parsed.data;
    },
    async bootstrap(raw:HistoryDestination,input:{brokerContactId:string;brokerConversationId:string;recipient:unknown;occurredAt:number;conversationId:number|null}) {
      const d=HistoryDestinationSchema.parse(raw);
      const body={...scope(d),broker_contact_id:uuid.parse(input.brokerContactId),broker_conversation_id:uuid.parse(input.brokerConversationId),
        recipient:input.recipient,occurred_at:z.number().int().nonnegative().safe().parse(input.occurredAt),conversation_id:positive.nullable().parse(input.conversationId)};
      return receipt(d,await request('POST',`${base(d)}/bootstrap`,body),{hash:historyConsumerRequestHash(body),conversation:body.broker_conversation_id,message:null});
    },
    async message(raw:HistoryDestination,input:{brokerConversationId:string;brokerMessageId:string;record:Fact}) {
      const d=HistoryDestinationSchema.parse(raw),r=HistorySyncRecordSchema.parse(input.record);
      if(r.kind!=='MESSAGE')invalid('HISTORY_CONSUMER_FACT_INVALID');
      const content=r.content.type==='TEXT'?r.content:{type:'MEDIA',reference_id:r.content.referenceId,media_type:r.content.mediaType,
        byte_size:r.content.byteSize,sha256:r.content.sha256,mime_type:r.content.mimeType,filename:r.content.filename,caption:r.content.caption};
      const body={...scope(d),broker_conversation_id:uuid.parse(input.brokerConversationId),broker_message_id:uuid.parse(input.brokerMessageId),
        provider_message_id:r.providerMessageId,content,direction:r.fromMe?'outgoing':'incoming',participant_jid:r.participantJid,
        occurred_at:r.messageTimestamp,status:r.state.toLowerCase()};
      const result=receipt(d,await request('POST',`${base(d)}/messages`,body),{hash:historyConsumerRequestHash(body),conversation:body.broker_conversation_id,message:body.broker_message_id});
      if(r.content.type==='MEDIA' && result.state==='PERSISTED' && result.media_sha256!==r.content.sha256)invalid('HISTORY_CONSUMER_MEDIA_ACK_MISMATCH');
      return result;
    },
    async receipt(raw:HistoryDestination,expected:HistoryConsumerReceipt,mediaSha256?:string) {
      const d=HistoryDestinationSchema.parse(raw),query=new URLSearchParams(Object.entries(scope(d)).map(([k,v])=>[k,String(v)] as [string,string]));
      const result=receipt(d,await request('GET',`${base(d)}/receipts/${uuid.parse(expected.receipt_id)}?${query}`),
        {hash:expected.request_hash,conversation:expected.broker_conversation_id,message:expected.broker_message_id});
      if(result.receipt_id!==expected.receipt_id || result.message_id!==expected.message_id || result.conversation_id!==expected.conversation_id)
        invalid('HISTORY_CONSUMER_RECEIPT_MISMATCH');
      if(result.state==='PERSISTED' && (expected.state==='MEDIA_PENDING' || mediaSha256!==undefined)
        && (!mediaSha256 || result.media_sha256!==sha.parse(mediaSha256)))invalid('HISTORY_CONSUMER_MEDIA_ACK_MISMATCH');
      return result;
    },
    async upload(raw:HistoryDestination,media:Media,bytes:Buffer) {
      const d=HistoryDestinationSchema.parse(raw);
      if(bytes.length!==media.byteSize || bytes.length>16*1024*1024 || createHash('sha256').update(bytes).digest('hex')!==media.sha256)
        invalid('HISTORY_CONSUMER_MEDIA_INTEGRITY');
      const form=new FormData();form.set('scope',JSON.stringify(scope(d)));
      form.set('metadata',JSON.stringify({reference_id:media.referenceId,media_type:media.mediaType,filename:media.filename,
        mime_type:media.mimeType,byte_size:media.byteSize,sha256:media.sha256}));
      form.set('file',new Blob([new Uint8Array(bytes)],{type:media.mimeType}),media.filename);
      const parsed=z.strictObject({protocol:z.literal('jrc-history-sync/2'),reference_id:uuid,state:z.literal('STORED'),sha256:sha})
        .safeParse(await request('POST',`${base(d)}/media`,form));
      if(!parsed.success || parsed.data.reference_id!==media.referenceId || parsed.data.sha256!==media.sha256)invalid('HISTORY_CONSUMER_MEDIA_ACK_MISMATCH');
      return parsed.data;
    },
  };
}
