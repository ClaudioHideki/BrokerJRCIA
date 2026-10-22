import {expect,it} from 'vitest';
import {verifyCanonicalCampaignMessage} from '../../src/modules/integrations/chatwoot-campaign-authority.js';
const intent={id:'11111111-1111-4111-8111-111111111111',actor_id:'7',campaign_id:'campaign:12',remote_conversation_id:'9',kind:'text',text:'Synthetic campaign'};
const message={id:15,conversation_id:9,inbox_id:4,message_type:'outgoing',private:false,content:'Synthetic campaign',sender:{id:7,type:'user'},attachments:[],additional_attributes:{jrc_campaign_intent_id:intent.id,jrc_campaign_broker:true,campaign_id:'campaign:12'}};
it('requires canonical outgoing content and exact issuer actor plus persisted intent',()=>{
 expect(()=>verifyCanonicalCampaignMessage(intent,message,{conversationId:9,messageId:15,inboxId:4})).not.toThrow();
});
it.each([{private:true},{content:'Forged'},{sender:{id:8,type:'user'}},{conversation_id:10},{inbox_id:5},{message_type:'incoming'},{additional_attributes:{campaign_id:'campaign:12'}}])('rejects a forged canonical campaign message %j',patch=>{
 expect(()=>verifyCanonicalCampaignMessage(intent,{...message,...patch},{conversationId:9,messageId:15,inboxId:4})).toThrow();
});
it('rejects changed canonical attachment IDs against the immutable reservation snapshot',()=>{
 const mediaIntent={...intent,kind:'image',attachment_ids:[71]};
 expect(()=>verifyCanonicalCampaignMessage(mediaIntent,{...message,attachments:[{id:72,file_type:'image'}]},{conversationId:9,messageId:15,inboxId:4})).toThrow();
 expect(()=>verifyCanonicalCampaignMessage(mediaIntent,{...message,attachments:[{id:71,file_type:'image'}]},{conversationId:9,messageId:15,inboxId:4})).not.toThrow();
});
