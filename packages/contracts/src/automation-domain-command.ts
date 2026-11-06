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
const text=(maximum:number)=>z.string().min(1).max(maximum).refine(value=>!value.includes('\0'));
const code=z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const intakeInput=z.strictObject({system:code,location:code,reason:code,subject:code,profile:code.optional(),
 severity:z.enum(['low','medium','high','critical']).optional(),identifier:text(30),email:text(254),
 description:text(5000).refine(value=>new TextEncoder().encode(value).byteLength<=6000)});
const intakeInputTemplate=z.strictObject({system:text(200),location:text(200),reason:text(200),subject:text(200),
 profile:text(200).optional(),severity:text(200).optional(),identifier:text(200),email:text(300),description:text(6000)});
export const DomainCommandConfigSchema=z.discriminatedUnion('command',[
 z.strictObject({...shared,command:z.literal('create_lead')}),
 z.strictObject({...shared,command:z.literal('create_task'),ownerId:owner,title,dueAt}),
 z.strictObject({...shared,command:z.literal('create_meeting'),ownerId:owner,title,dueAt}),
 z.strictObject({...shared,command:z.literal('service_desk_intake'),configurationId:owner,configurationRevision:owner,
  phase:z.enum(['qualified','handoff']),input:intakeInputTemplate}),
 z.strictObject({...shared,command:z.literal('service_desk_status')}),
]);
export type DomainCommandConfig=z.infer<typeof DomainCommandConfigSchema>;
export const DomainCommandArgumentsSchema=z.discriminatedUnion('command',[
 z.strictObject({command:z.literal('create_lead')}),
 z.strictObject({command:z.literal('create_task'),owner_id:owner,title,due_at:date}),
 z.strictObject({command:z.literal('create_meeting'),owner_id:owner,title,due_at:date}),
 z.strictObject({command:z.literal('service_desk_intake'),configuration_id:owner,configuration_revision:owner,
  episode_key:z.uuid(),phase:z.enum(['qualified','handoff']),input:intakeInput}),
 z.strictObject({command:z.literal('service_desk_status'),episode_key:z.uuid()}),
]);
const crmResult=z.strictObject({command:z.enum(['create_lead','create_task','create_meeting']),
 resource_type:z.enum(['JrcCrm::Lead','JrcCrm::Activity']),resource_id:owner,created:z.boolean(),delivery:z.literal('NOT_APPLICABLE'),
 event:z.strictObject({id:z.uuid(),causation_id:z.uuid(),type:z.enum(['crm.lead.ready','crm.activity.created'])}),
}).refine(result=>result.command==='create_lead'
 ?result.resource_type==='JrcCrm::Lead'&&result.event.type==='crm.lead.ready'
 :result.resource_type==='JrcCrm::Activity'&&result.event.type==='crm.activity.created'&&result.created);
const stage=z.strictObject({id:z.string().regex(/^[1-9]\d*$/u).optional(),
 state:z.enum(['pending','sending','succeeded','rejected','indeterminate','not_required']),error_code:z.string().max(100).nullable().optional()});
export const IntakeDemandReceiptSchema=z.strictObject({id:z.string().regex(/^[1-9]\d*$/u),episode_key:z.uuid(),
 configuration_id:z.string().regex(/^[1-9]\d*$/u),created:z.boolean(),
 state:z.enum(['qualified','queued','sending','confirmed','partial','rejected','indeterminate','test_only']),
 remote_id:z.string().regex(/^[1-9]\d*$/u).nullable(),error_code:z.string().max(100).nullable(),
 stages:z.strictObject({ticket:stage.optional(),link:stage.optional(),assignment:stage.optional(),sla:stage.optional()}),
}).refine(value=>!['confirmed','partial'].includes(value.state)||value.remote_id!==null);
const intakeResult=z.strictObject({command:z.enum(['service_desk_intake','service_desk_status']),
 resource_type:z.literal('JrcServiceDesk::IntakeDemand'),resource_id:owner,created:z.boolean(),delivery:z.literal('NOT_APPLICABLE'),
 event:z.strictObject({id:z.uuid(),causation_id:z.uuid(),type:z.literal('service_desk.intake.recorded')}),intake:IntakeDemandReceiptSchema,
}).refine(value=>String(value.resource_id)===value.intake.id&&value.created===value.intake.created);
export const DomainCommandResultSchema=z.union([crmResult,intakeResult]);
