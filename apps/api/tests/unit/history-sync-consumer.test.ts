import { randomUUID,createHash } from 'node:crypto';
import { expect,it,vi } from 'vitest';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';
import { hashIdempotencyRequest } from '../../src/modules/instances/idempotency.js';
import { readFileSync } from 'node:fs';
import { historyConsumerRequestHash } from '../../src/modules/history-sync/consumer.js';

const destination={organizationId:randomUUID(),channelId:randomUUID(),integrationId:randomUUID(),instanceId:randomUUID(),
  historyAccountIdentity:randomUUID(),accountId:7,inboxId:9,destinationRevision:1};
const envelope={protocol:'jrc-history-sync/2',account_id:7,inbox_id:9,organization_id:destination.organizationId,
  integration_id:destination.integrationId,history_account_identity:destination.historyAccountIdentity,destination_revision:1};
const fact={kind:'MESSAGE' as const,recipientKind:'INDIVIDUAL' as const,chatJid:'15555550101@s.whatsapp.net',providerMessageId:'synthetic-message',
  fromMe:false,participantJid:null,messageTimestamp:1600000000,displayName:null,state:'DELIVERED' as const,content:{type:'TEXT' as const,text:'Synthetic text'}};
function fixture(transform:(body:Record<string,unknown>)=>Record<string,unknown>=body=>body) {
  const fetch=vi.fn(async(url:unknown,init:RequestInit|undefined)=>{
    if(init?.method==='GET')return Response.json({...envelope,supports_text:true,supports_groups:true,supports_media:true,max_media_bytes:16777216,supports_silent_bootstrap:true});
    const body=JSON.parse(String(init?.body)),semantic={...body};delete semantic.status;delete semantic.instance_id;delete semantic.destination_revision;
    const response={...envelope,receipt_id:randomUUID(),request_hash:hashIdempotencyRequest(semantic),state:'PERSISTED',
      conversation_id:12,contact_id:13,source_id:'synthetic-source',broker_conversation_id:body.broker_conversation_id,
      broker_message_id:body.broker_message_id??null,message_id:body.broker_message_id?14:null};
    return Response.json(transform(response));
  });
  return {fetch,client:new ChatwootClient({baseUrl:'https://synthetic.example.test',token:'synthetic-test-token',fetch:fetch as typeof globalThis.fetch})};
}
it('uses only versioned silent endpoints and validates the correlated immutable request receipt',async()=>{
  const f=fixture(),consumer=f.client.historySyncV2(),conversation=randomUUID();
  expect(await consumer.capability(destination)).toMatchObject({supports_groups:true,supports_media:true});
  const boot=await consumer.bootstrap(destination,{brokerContactId:randomUUID(),brokerConversationId:conversation,
    recipient:{kind:'INDIVIDUAL',jid:fact.chatJid,name:'Synthetic contact'},occurredAt:fact.messageTimestamp,conversationId:null});
  expect(boot).toMatchObject({conversation_id:12,state:'PERSISTED'});
  const message=await consumer.message(destination,{brokerConversationId:conversation,brokerMessageId:randomUUID(),record:fact});
  expect(message).toMatchObject({message_id:14,state:'PERSISTED'});
  expect(f.fetch.mock.calls.every(call=>String(call[0]).includes('/jrc_history_sync/v2/inboxes/9'))).toBe(true);
});
it('refuses a tenant-mismatched or altered receipt instead of falling back to a live message endpoint',async()=>{
  for(const transform of [(body:Record<string,unknown>)=>({...body,organization_id:randomUUID()}),
    (body:Record<string,unknown>)=>({...body,request_hash:'a'.repeat(64)})]) {
    const f=fixture(transform);
    await expect(f.client.historySyncV2().message(destination,{brokerConversationId:randomUUID(),brokerMessageId:randomUUID(),record:fact}))
      .rejects.toThrow('HISTORY_CONSUMER_RECEIPT_MISMATCH');
    expect(f.fetch).toHaveBeenCalledTimes(1);
  }
});
it('does not turn pending media into a final custody acknowledgement',async()=>{
  const f=fixture(body=>({...body,state:'MEDIA_PENDING'}));
  const receipt=await f.client.historySyncV2().message(destination,{brokerConversationId:randomUUID(),brokerMessageId:randomUUID(),record:fact});
  expect(receipt.state).toBe('MEDIA_PENDING');
});
it('checks media bytes before transport and sends no upload when a checksum differs',async()=>{
  const f=fixture(),bytes=Buffer.from('Synthetic bytes');
  const media={type:'MEDIA' as const,referenceId:randomUUID(),mediaType:'DOCUMENT' as const,byteSize:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),mimeType:'text/plain',filename:'synthetic.txt',caption:''};
  await expect(f.client.historySyncV2().upload(destination,media,Buffer.from('Wrong bytes'))).rejects.toThrow('HISTORY_CONSUMER_MEDIA_INTEGRITY');
  expect(f.fetch).not.toHaveBeenCalled();
});
it('requires a matching physical checksum before accepting a final media receipt',async()=>{
  const media={...fact,content:{type:'MEDIA' as const,referenceId:randomUUID(),mediaType:'DOCUMENT' as const,byteSize:12,
    sha256:'b'.repeat(64),mimeType:'text/plain',filename:'synthetic.txt',caption:'Synthetic caption'}};
  const f=fixture();
  await expect(f.client.historySyncV2().message(destination,{brokerConversationId:randomUUID(),brokerMessageId:randomUUID(),record:media}))
    .rejects.toThrow('HISTORY_CONSUMER_MEDIA_ACK_MISMATCH');
});
it('matches the shared Ruby/JavaScript canonical fixture for HTML, emoji and Unicode separators',()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../../packages/contracts/fixtures/history-canonical-v2.json',import.meta.url),'utf8'));
  expect(historyConsumerRequestHash(fixture.value)).toBe(fixture.sha256);
});
