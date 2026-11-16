import {expect,it} from 'vitest';
import {humanOutboundIntent,requireCanonicalHumanIntent} from '../../src/modules/integrations/chatwoot-human-intent.js';

const integrationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',intentId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const marker={version:1,state:'PENDING',intent_id:intentId,integration_id:integrationId,inbox_id:9};
const expected={intentId,integrationId,accountId:7,inboxId:9,conversationId:52,messageId:701,senderId:12,content:{type:'TEXT' as const,text:'Synthetic human intent'}};
const canonical=()=>({id:701,account_id:7,inbox_id:9,conversation_id:52,message_type:1,private:false,sender:{id:12,type:'user'},
  content:'Synthetic human intent',content_attributes:{jrc_broker_outbound:marker},attachments:[]});

it('requires the current integration and inbox even to retain the intent hint',()=>{
  expect(humanOutboundIntent({jrc_broker_outbound:marker},{integrationId,inboxId:9})).toBe(intentId);
  expect(humanOutboundIntent({jrc_broker_outbound:marker},{integrationId,inboxId:10})).toBeUndefined();
  expect(humanOutboundIntent({jrc_broker_outbound:marker},{integrationId:intentId,inboxId:9})).toBeUndefined();
  expect(humanOutboundIntent({jrc_broker_outbound:{...marker,state:'SENT'}},{integrationId,inboxId:9})).toBeUndefined();
});
it('accepts only an exact canonical public human message',()=>{
  expect(()=>requireCanonicalHumanIntent(canonical(),expected)).not.toThrow();
});
it.each([
  {inbox_id:10},{account_id:8},{conversation_id:53},{id:702},{private:true},{message_type:0},
  {sender:{id:12,type:'agent_bot'}},{sender:{id:13,type:'user'}},{content:'Changed content'},
  {content_attributes:{jrc_broker_outbound:marker,jrc_broker_message_id:intentId}},
  {content_attributes:{jrc_broker_outbound:marker,jrc_broker_historical:true}},
  {additional_attributes:{jrc_broker_historical:true}},{additional_attributes:{campaign_id:77}},
  {content_attributes:{jrc_broker_outbound:marker,automation_rule_id:1}},
  {attachments:[{id:801,file_type:'image'}]},
])('rejects canonical drift %# without treating a marker as dispatch proof',patch=>{
  expect(()=>requireCanonicalHumanIntent({...canonical(),...patch},expected)).toThrow('CHATWOOT_HUMAN_INTENT_NOT_PROVEN');
});
it('pins exact attachment IDs/kinds and caption rather than an editable display name',()=>{
  const media={...canonical(),content:'Caption',attachments:[{id:801,file_type:'image'},{id:802,file_type:'file'}]};
  const want={...expected,content:undefined,caption:'Caption',attachments:[{id:801,kind:'image' as const},{id:802,kind:'document' as const}]};
  expect(()=>requireCanonicalHumanIntent(media,want)).not.toThrow();
  expect(()=>requireCanonicalHumanIntent({...media,attachments:[{id:801,file_type:'image'},{id:801,file_type:'file'}]},want)).toThrow('CHATWOOT_HUMAN_INTENT_NOT_PROVEN');
  expect(()=>requireCanonicalHumanIntent({...media,content:'Other caption'},want)).toThrow('CHATWOOT_HUMAN_INTENT_NOT_PROVEN');
});
