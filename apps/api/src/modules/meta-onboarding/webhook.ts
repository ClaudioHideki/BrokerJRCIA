import {z} from 'zod';
const envelope=z.object({object:z.literal('whatsapp_business_account'),entry:z.array(z.object({id:z.string().regex(/^\d{5,64}$/),changes:z.array(z.object({field:z.string(),value:z.unknown()})).max(100)})).max(100)});
/** Must be invoked only by the existing raw-body HMAC-verified Meta webhook route. */
export function createMetaOnboardingWebhook(options:{
 ingestMessages(payload:unknown):Promise<void>;
 findWaba(wabaId:string):Promise<Array<{organizationId:string;id:string}>>;
 accountUpdated(organizationId:string,id:string):Promise<void>;
}) {
 return async(payload:unknown)=>{
  const body=envelope.parse(payload);
  for(const entry of body.entry) {
   if(entry.changes.some(change=>['account_update','account_review_update'].includes(change.field))) {
    for(const binding of await options.findWaba(entry.id)) await options.accountUpdated(binding.organizationId,binding.id);
   }
   const messages=entry.changes.filter(change=>change.field==='messages');
   if(messages.length) await options.ingestMessages({object:body.object,entry:[{id:entry.id,changes:messages}]});
  }
 };
}
