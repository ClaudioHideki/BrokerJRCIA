import {expect,it,vi} from 'vitest';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
const organizationId='4f2491a2-6853-4ac2-a7ef-c997813a9182',integrationId='81555d45-b1a2-4a3f-ab95-c1459b0df0d0',messageId='28733236-e585-4611-aae4-88b1ea10c4c3';
const scope={organizationId,integrationId,inboxId:31};
const capability={protocol:'jrc-history-import/1',account_id:1,inbox_id:31,organization_id:organizationId,integration_id:integrationId,supports_text:true};
const receipt={...capability,conversation_id:51,broker_message_id:messageId,id:61};
delete (receipt as Partial<typeof capability>).supports_text;
it('uses the separate import protocol, preserves original dates and rejects a receipt for a different scope',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(Response.json(capability)).mockResolvedValueOnce(Response.json(receipt))
  .mockResolvedValueOnce(Response.json({...receipt,inbox_id:32}));
 const client=new ChatwootClient({baseUrl:'https://conversas.test',token:'synthetic-only',fetch});
 expect(await client.historyImportCapability(1,scope)).toEqual(capability);
 const input={...scope,brokerMessageId:messageId,text:'Archived text',incoming:false,occurredAt:1792000000,status:'read' as const};
 expect(await client.importHistoryMessage(1,51,input)).toBe(61);
 expect(String(fetch.mock.calls[1]![0])).toBe('https://conversas.test/api/v1/accounts/1/conversations/51/jrc_history_import');
 expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({organization_id:organizationId,integration_id:integrationId,inbox_id:31,broker_message_id:messageId,
  content:'Archived text',direction:'outgoing',occurred_at:1792000000,status:'read'});
 await expect(client.importHistoryMessage(1,51,input)).rejects.toMatchObject({code:'CHATWOOT_BINDING_MISMATCH'});
});
it('does not pretend that stock or older central endpoints support silent historical import',async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response('{}',{status:404}));
 const client=new ChatwootClient({baseUrl:'https://conversas.test',token:'synthetic-only',fetch});
 await expect(client.historyImportCapability(1,scope)).rejects.toMatchObject({code:'CHATWOOT_HISTORY_UNSUPPORTED',uncertain:false});
 expect(fetch).toHaveBeenCalledTimes(1);
});
it('allows an idempotent historical POST to be retried after an ambiguous transport outcome',async()=>{
 const client=new ChatwootClient({baseUrl:'https://conversas.test',token:'synthetic-only',fetch:vi.fn().mockRejectedValue(new Error('synthetic disconnect'))});
 await expect(client.importHistoryMessage(1,51,{...scope,brokerMessageId:messageId,text:'Archived text',incoming:true,occurredAt:1792000000,status:'delivered'}))
  .rejects.toMatchObject({code:'CHATWOOT_HISTORY_UNAVAILABLE',retrySafe:true,uncertain:false});
});
it('binds a silent bootstrap receipt to both broker identities and the exact central scope',async()=>{
 const input={...scope,brokerContactId:messageId,brokerConversationId:organizationId,phone:'15550000001',name:'Synthetic',occurredAt:1792000000};
 const data={protocol:'jrc-history-import/1',account_id:1,inbox_id:31,organization_id:organizationId,integration_id:integrationId,
  contact_id:41,source_id:'synthetic-source',conversation_id:51,broker_contact_id:messageId,broker_conversation_id:organizationId};
 const fetch=vi.fn().mockResolvedValueOnce(Response.json(data)).mockResolvedValueOnce(Response.json({...data,broker_contact_id:integrationId}));
 const client=new ChatwootClient({baseUrl:'https://conversas.test',token:'synthetic-only',fetch});
 expect(await client.bootstrapHistoryConversation(1,input)).toEqual(data);
 await expect(client.bootstrapHistoryConversation(1,input)).rejects.toMatchObject({code:'CHATWOOT_BINDING_MISMATCH'});
 expect(String(fetch.mock.calls[0]![0])).toBe('https://conversas.test/api/v1/accounts/1/jrc_history_import/inboxes/31/bootstrap');
});
