import {z} from 'zod';
import {DataVariableKeySchema} from './automation-data-v2.js';

const title=z.string().refine(value=>Boolean(value.trim())&&new TextEncoder().encode(value).byteLength<=200);
const owner=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date=z.string().max(40).datetime({offset:true});
const dueAt=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('LITERAL'),value:date}),
 z.strictObject({kind:z.literal('VARIABLE'),variable:DataVariableKeySchema}),
]);
const shared={conversationEffectVersion:z.literal(2),operation:z.literal('domain'),channelId:z.uuid(),
 target:DataVariableKeySchema,timeoutMs:z.number().int().min(100).max(30000)};
export const DomainCommandConfigSchema=z.discriminatedUnion('command',[
 z.strictObject({...shared,command:z.literal('create_lead')}),
 z.strictObject({...shared,command:z.literal('create_task'),ownerId:owner,title,dueAt}),
 z.strictObject({...shared,command:z.literal('create_meeting'),ownerId:owner,title,dueAt}),
]);
export type DomainCommandConfig=z.infer<typeof DomainCommandConfigSchema>;
export const DomainCommandArgumentsSchema=z.discriminatedUnion('command',[
 z.strictObject({command:z.literal('create_lead')}),
 z.strictObject({command:z.literal('create_task'),owner_id:owner,title,due_at:date}),
 z.strictObject({command:z.literal('create_meeting'),owner_id:owner,title,due_at:date}),
]);
export const DomainCommandResultSchema=z.strictObject({command:z.enum(['create_lead','create_task','create_meeting']),
 resource_type:z.enum(['JrcCrm::Lead','JrcCrm::Activity']),resource_id:owner,created:z.boolean(),delivery:z.literal('NOT_APPLICABLE'),
 event:z.strictObject({id:z.uuid(),causation_id:z.uuid(),type:z.enum(['crm.lead.ready','crm.activity.created'])}),
}).refine(result=>result.command==='create_lead'
 ?result.resource_type==='JrcCrm::Lead'&&result.event.type==='crm.lead.ready'
 :result.resource_type==='JrcCrm::Activity'&&result.event.type==='crm.activity.created'&&result.created);
