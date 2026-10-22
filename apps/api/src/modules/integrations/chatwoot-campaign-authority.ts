import { IntegrationError } from './integration-error.js';
import type { TenantTransaction } from '../../db/tenant-transaction.js';

export interface CampaignIntent {
 id:string; actor_id:string; campaign_id:string; remote_conversation_id:string; remote_message_id?:string;
 kind:string; text:string;
 attachment_ids?:number[];
 remote_contact_id?:string; recipient_phone?:string; recipient_source_id?:string;
}
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** Canonical API reads, never callback metadata alone, establish the message being authorized. */
export function verifyCanonicalCampaignMessage(intent:CampaignIntent,raw:unknown,scope:{conversationId:number;messageId:number;inboxId:number},requireIntentReference=true){
 const m=object(raw),sender=object(m.sender),attrs=object(m.additional_attributes);
 const attachments=Array.isArray(m.attachments)?m.attachments:[];
 const expectedKind=intent.kind==='document'?'file':intent.kind;
 if(m.id!==scope.messageId||m.conversation_id!==scope.conversationId||m.inbox_id!==scope.inboxId||
  Number(intent.remote_conversation_id)!==scope.conversationId||(intent.remote_message_id!==undefined&&Number(intent.remote_message_id)!==scope.messageId)||
  !['outgoing',1].includes(m.message_type as string|number)||m.private!==false||sender.type!=='user'||String(sender.id)!==intent.actor_id||
  attrs.jrc_campaign_broker!==true||String(attrs.campaign_id)!==intent.campaign_id||
  (requireIntentReference&&attrs.jrc_campaign_intent_id!==intent.id)||String(m.content??'')!==intent.text||
  (intent.kind==='text'?attachments.length!==0:attachments.length!==1||object(attachments[0]).file_type!==expectedKind)||
  (intent.attachment_ids!==undefined&&JSON.stringify(intent.attachment_ids)!==JSON.stringify(attachments.map(a=>Number(object(a).id)))))
  throw new IntegrationError('CAMPAIGN_MESSAGE_NOT_PROVEN',409);
 return {attachmentIds:attachments.map(a=>Number(object(a).id))};
}
export async function requireCampaignIntent(t:TenantTransaction,org:string,id:string,integration:string,conversation:number,message:number,actor?:number){
 const row=(await t.query<CampaignIntent>(`SELECT i.* FROM chatwoot_campaign_intents i
  WHERE i.organization_id=$1 AND i.id=$2 AND i.integration_id=$3 AND i.remote_conversation_id=$4 AND i.remote_message_id=$5
   AND ($6::text IS NULL OR i.actor_id=$6) AND campaign_intent_authorized(i.organization_id,i.id,false) FOR SHARE`,
  [org,id,integration,conversation,message,actor===undefined?null:String(actor)])).rows[0];
 if(!row)throw new IntegrationError('CAMPAIGN_AUTHORITY_REVOKED',409);
 return row;
}
