import {z} from 'zod';
import {CentralMediaInputSchema} from './chatwoot-runtime-event.js';
const id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const canonical=z.object({id,conversation_id:id,message_type:z.union([z.literal('incoming'),z.literal(0)]),private:z.literal(false),
 content:z.string().max(4096).nullable().optional(),content_type:z.literal('text').optional(),sender:z.object({id,type:z.literal('contact')}),created_at:z.number().finite().nonnegative(),
 attachments:z.array(z.object({id,message_id:id,account_id:id,file_type:z.enum(['image','file'])})).min(1).max(10)});
/** A scoped API GET proves these identities; URLs and captions are not input data. */
export function canonicalCentralMedia(raw:unknown,scope:{accountId:number;conversationId:number;messageId:number;expected:unknown}){
 const parsed=canonical.safeParse(raw),expected=CentralMediaInputSchema.safeParse(scope.expected);
 if(!parsed.success||!expected.success)throw Error('CENTRAL_CANONICAL_MISMATCH');
 const message=parsed.data,attachments=message.attachments;
 if(message.id!==scope.messageId||message.conversation_id!==scope.conversationId||message.sender.id!==expected.data.contactId||
  attachments.length!==expected.data.attachments.length||new Set(attachments.map(a=>a.id)).size!==attachments.length||
  attachments.some(a=>a.account_id!==scope.accountId||a.message_id!==scope.messageId||
    !expected.data.attachments.some(e=>e.id===a.id&&e.kind===(a.file_type==='file'?'document':'image'))))throw Error('CENTRAL_CANONICAL_MISMATCH');
 return {createdAt:message.created_at,attachments:expected.data.attachments.map(a=>({...a,fileName:`anexo-${a.id}`}))};
}
