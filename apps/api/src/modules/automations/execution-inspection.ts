import {createHash} from 'node:crypto';
import {z} from 'zod';
import {AutomationExecutionQuerySchema,type AutomationExecutionQuery,type AutomationExecutionPage} from '@jrc/contracts';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import {AutomationError} from './errors.js';

const cursorSchema=z.strictObject({organizationId:z.uuid(),filter:z.string().regex(/^[a-f0-9]{64}$/),startedAt:z.iso.datetime(),id:z.uuid(),from:z.iso.datetime(),to:z.iso.datetime()});
const DAY=86400000;
export function prepareExecutionSearch(org:string,input:AutomationExecutionQuery,authorization?:{channelIds:string[];scopeKey:string}){
 const parsed=AutomationExecutionQuerySchema.safeParse(input);if(!parsed.success)throw new AutomationError('AUTOMATION_EXECUTION_QUERY_INVALID',400);
 const query={...parsed.data,pageSize:parsed.data.pageSize??50};let cursor:z.infer<typeof cursorSchema>|undefined;
 if(query.cursor)try{cursor=cursorSchema.parse(JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8')));}catch{throw new AutomationError('AUTOMATION_CURSOR_INVALID',400);}
 if(!query.from||!query.to)throw new AutomationError('AUTOMATION_EXECUTION_PERIOD_INVALID',400);
 const to=query.to,from=query.from;
 if(Date.parse(from)>=Date.parse(to)||Date.parse(to)-Date.parse(from)>31*DAY)throw new AutomationError('AUTOMATION_EXECUTION_PERIOD_INVALID',400);
 const values:unknown[]=[org,query.automationId??null,query.status??null,query.channelId??null,from,to,query.search??null,query.nodeId??null,authorization?.channelIds??null];
 const filter=createHash('sha256').update(JSON.stringify([values,authorization?.scopeKey??null])).digest('hex');
 if(cursor&&(cursor.organizationId!==org||cursor.filter!==filter))throw new AutomationError('AUTOMATION_CURSOR_INVALID',400);
 return {query,from,to,values,filter,cursor,authorization};
}

type Row=AutomationExecutionPage['data'][number]&{cursorStartedAt:string};
const conditions=`e.organization_id=$1 and ($2::uuid is null or e.automation_id=$2) and ($3::text is null or e.status=$3)
 and ($4::uuid is null or e.channel_id=$4) and e.started_at>=$5::timestamptz and e.started_at<$6::timestamptz
 and ($7::uuid is null or e.id=$7 or e.conversation_id=$7 or e.correlation_id=$7) and ($8::text is null or e.current_node_id=$8) and ($9::uuid[] is null or e.channel_id=any($9::uuid[]))`;
/** Tenant-scoped metadata only: no message text, contact PII, credentials or runtime payloads. */
export async function readExecutionPage(tx:TenantTransaction,search:ReturnType<typeof prepareExecutionSearch>):Promise<AutomationExecutionPage>{
 const {query,from,to,values,filter,cursor}=search;
 const rows=(await tx.query<Row>(`select 1 as "schemaVersion",e.id,e.organization_id as "organizationId",e.automation_id as "automationId",e.version,
 e.binding_id as "bindingId",e.channel_id as "channelId",e.status,e.current_node_id as "currentNodeId",e.correlation_id as "correlationId",
 e.conversation_id as "conversationRef",e.error_code as "errorCode",e.started_at as "startedAt",e.updated_at as "updatedAt",e.completed_at as "completedAt",
 greatest(0,extract(epoch from(coalesce(e.completed_at,now())-e.started_at))*1000)::float8 as "durationMs",
 to_char(e.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorStartedAt"
 from automation_executions e where ${conditions} and ($10::timestamptz is null or (e.started_at,e.id)<($10::timestamptz,$11::uuid))
 order by e.started_at desc,e.id desc limit $12`,[...values,cursor?.startedAt??null,cursor?.id??null,query.pageSize+1])).rows;
 const counts=(await tx.query<Omit<AutomationExecutionPage['metrics'],'completionRate'>>(`select count(*)::int as total,
 count(*) filter(where e.status='COMPLETED')::int as completed,count(*) filter(where e.status in ('QUEUED','RUNNING','WAITING'))::int as active,
 count(*) filter(where e.status='FAILED')::int as failed,count(*) filter(where e.status='UNKNOWN')::int as unknown,
 count(*) filter(where e.status='CANCELED')::int as canceled,count(*) filter(where e.status='HANDOFF')::int as handoff
 from automation_executions e where ${conditions}`,values)).rows[0]!;
 const page=rows.slice(0,query.pageSize),last=page.at(-1),iso=(value:unknown)=>value instanceof Date?value.toISOString():String(value);
 return {data:page.map(({cursorStartedAt:_,...row})=>({...row,...(search.authorization?{errorCode:safeExecutionCode(row.errorCode)}:{}),startedAt:iso(row.startedAt),updatedAt:iso(row.updatedAt),completedAt:row.completedAt?iso(row.completedAt):null})),
  nextCursor:rows.length>query.pageSize&&last?Buffer.from(JSON.stringify({organizationId:values[0],filter,startedAt:last.cursorStartedAt,id:last.id,from,to})).toString('base64url'):null,
  metrics:{...counts,completionRate:counts.total?Math.round(counts.completed/counts.total*10000)/100:null},period:{from,to}};
}

const publicExecutionCodes=new Set(['AUTOMATION_STEP_LIMIT','AUTOMATION_EXECUTION_FAILED','AUTOMATION_VERSION_NOT_FOUND','AUTOMATION_DEPENDENCY_LIMIT','AUTOMATION_INVALID','AUTOMATION_WAIT_TIMEOUT']);
export const safeExecutionCode=(value:string|null)=>value&&publicExecutionCodes.has(value)?value:value?'EXECUTION_DETAILS_PROTECTED':null;
