import {z} from 'zod';
import {createHash} from 'node:crypto';
export const META_MANAGEMENT_FIELDS=['account_update','account_review_update','phone_number_name_update','phone_number_quality_update','business_capability_update','message_template_status_update','message_template_quality_update'] as const;
export type MetaManagementField=typeof META_MANAGEMENT_FIELDS[number];
const envelope=z.object({object:z.literal('whatsapp_business_account'),entry:z.array(z.object({id:z.string().regex(/^\d{5,64}$/),time:z.number().optional(),changes:z.array(z.object({field:z.string(),value:z.unknown()})).max(100)})).max(100)});
function canonical(value:unknown):string {
 if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
 if(value && typeof value==='object') return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value)??'null';
}
/** Must be invoked only by the existing raw-body HMAC-verified Meta webhook route. */
export function createMetaOnboardingWebhook(options:{
 ingestMessages(payload:unknown):Promise<void>;
 findWaba(wabaId:string):Promise<Array<{organizationId:string;id:string}>>;
 managementUpdated(organizationId:string,id:string,field:MetaManagementField,fingerprint:string):Promise<boolean|void>;
 refreshConnection(organizationId:string,id:string):Promise<unknown>;
}) {
 return async(payload:unknown)=>{
  const body=envelope.parse(payload);
  const seen=new Set<string>();
  const rechecks=new Map<string,{organizationId:string;id:string}>();
  const messageEntries:Array<{id:string;changes:Array<{field:string;value?:unknown}>}>=[];
  for(const entry of body.entry) {
   const changes=entry.changes.filter(change=>META_MANAGEMENT_FIELDS.includes(change.field as MetaManagementField));
   if(changes.length) for(const binding of await options.findWaba(entry.id)) for(const change of changes) {
    const fingerprint=createHash('sha256').update(canonical([entry.id,entry.time??null,change.field,change.value])).digest('hex');
    const key=`${binding.organizationId}:${binding.id}:${fingerprint}`;
    if(seen.has(key)) continue;
    if(await options.managementUpdated(binding.organizationId,binding.id,change.field as MetaManagementField,fingerprint))
     rechecks.set(`${binding.organizationId}:${binding.id}`,binding);
    seen.add(key);
   }
   const messages=entry.changes.filter(change=>change.field==='messages');
   if(messages.length) messageEntries.push({id:entry.id,changes:messages});
  }
  // First commit every invalidation. Graph latency cannot leave a sibling number eligible.
  for(const entry of messageEntries) await options.ingestMessages({object:body.object,entry:[entry]});
  const bindings=[...rechecks.values()];
  for(let i=0;i<bindings.length;i+=4) await Promise.all(bindings.slice(i,i+4).map(async binding=>{
   try {await options.refreshConnection(binding.organizationId,binding.id);} catch {/* Durable PENDING; operator can retry safely. */}
  }));
 };
}
