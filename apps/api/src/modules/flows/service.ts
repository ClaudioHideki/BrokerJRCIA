import { FlowGraphSchema, validateFlow, executeFlow, FLOW_ORIGIN, type FlowGraph, type FlowState } from '@jrc/contracts';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import { createPostgresMessagingRepository } from '../messaging/repository.js';
import type { BotTurnClaim } from '../messaging/types.js';

export class FlowError extends Error {
  constructor(readonly code:string,readonly statusCode=422,readonly details:string[]=[]){super(code);}
}
export interface FlowRecord {id:string;name:string;graph:FlowGraph;revision:number;publishedVersion:number|null;updatedAt:string}
export interface FlowServiceOptions {transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>}
const columns='id,name,graph,revision,published_version AS "publishedVersion",updated_at AS "updatedAt"';
type Feature={enabled:boolean;revision:number;updated_at:Date};
export function createFlowService({transact}:FlowServiceOptions){
  const messaging=createPostgresMessagingRepository();
  async function feature(tx:TenantTransaction,org:string):Promise<Feature>{
    const row=(await tx.query<Feature>(`select f.* from flow_features f join organizations o on o.id=f.organization_id where f.organization_id=$1 and o.status='ACTIVE'`,[org])).rows[0];
    if(!row?.enabled)throw new FlowError('FLOWS_DISABLED',403);
    return row;
  }
  async function get(tx:TenantTransaction,org:string,id:string,lock=false):Promise<FlowRecord>{
    const row=(await tx.query<FlowRecord>(`select ${columns} from flows where organization_id=$1 and id=$2 ${lock?'for update':''}`,[org,id])).rows[0];
    if(!row)throw new FlowError('FLOW_NOT_FOUND',404);return row;
  }
  const service={
    status:(org:string)=>transact(org,async tx=>({enabled:(await tx.query(`select f.enabled from flow_features f join organizations o on o.id=f.organization_id where f.organization_id=$1 and o.status='ACTIVE'`,[org])).rows[0]?.enabled===true})),
    list:(org:string)=>transact(org,async tx=>{await feature(tx,org);return {data:(await tx.query<FlowRecord>(`select ${columns} from flows where organization_id=$1 order by updated_at desc limit 200`,[org])).rows};}),
    channels:(org:string)=>transact(org,async tx=>{await feature(tx,org);return {data:(await tx.query(`select id,provider,bot_public_id IS NOT NULL AS "hasAutomation",
      case when bot_origin_reference=$2 then bot_public_id else null end AS "flowId"
      from messaging_channels where organization_id=$1 order by created_at`,[org,FLOW_ORIGIN])).rows};}),
    get:(org:string,id:string)=>transact(org,async tx=>{await feature(tx,org);return get(tx,org,id);}),
    create:(org:string,input:{name:string;graph:FlowGraph})=>transact(org,async tx=>{
      await feature(tx,org);const graph=FlowGraphSchema.parse(input.graph);
      await tx.query("select pg_advisory_xact_lock(hashtextextended('flows-quota:'||$1,0))",[org]);
      if(!(input.name.trim().length>0&&input.name.length<=120))throw new FlowError('FLOW_NAME_INVALID');
      const count=(await tx.query('select count(*)::int n from flows where organization_id=$1',[org])).rows[0].n;
      if(count>=200)throw new FlowError('FLOW_LIMIT',409);
      return (await tx.query<FlowRecord>(`insert into flows(organization_id,name,graph) values($1,$2,$3) returning ${columns}`,[org,input.name.trim(),JSON.stringify(graph)])).rows[0]!;
    }),
    save:(org:string,id:string,input:{name:string;graph:FlowGraph;revision:number})=>transact(org,async tx=>{
      await feature(tx,org);const flow=await get(tx,org,id,true);
      if(flow.revision!==input.revision)throw new FlowError('FLOW_CHANGED',409);
      const graph=FlowGraphSchema.parse(input.graph);
      return (await tx.query<FlowRecord>(`update flows set name=$3,graph=$4,revision=revision+1,updated_at=now() where organization_id=$1 and id=$2 returning ${columns}`,[org,id,input.name.trim(),JSON.stringify(graph)])).rows[0]!;
    }),
    publish:(org:string,id:string,revision:number)=>transact(org,async tx=>{
      await feature(tx,org);const flow=await get(tx,org,id,true);
      if(flow.revision!==revision)throw new FlowError('FLOW_CHANGED',409);
      const errors=validateFlow(flow.graph);if(errors.length)throw new FlowError('FLOW_INVALID',422,errors);
      const version=(flow.publishedVersion??0)+1;
      await tx.query('insert into flow_versions(organization_id,flow_id,version,graph) values($1,$2,$3,$4)',[org,id,version,JSON.stringify(flow.graph)]);
      return (await tx.query<FlowRecord>(`update flows set published_version=$3,updated_at=now() where organization_id=$1 and id=$2 returning ${columns}`,[org,id,version])).rows[0]!;
    }),
    bind:(org:string,id:string,channelId:string,replaceAutomation=false)=>transact(org,async tx=>{
      await feature(tx,org);const flow=await get(tx,org,id);
      if(!flow.publishedVersion)throw new FlowError('FLOW_NOT_PUBLISHED',409);
      const current=await messaging.findChannel(tx,org,channelId);
      if(!current)throw new FlowError('CHANNEL_NOT_FOUND',404);
      if(current.botPublicId&&(current.botPublicId!==id||current.botOriginReference!==FLOW_ORIGIN)&&!replaceAutomation)throw new FlowError('FLOW_REPLACE_REQUIRED',409);
      const result=await messaging.setChannelBot(tx,{organizationId:org,channelId,botPublicId:id,botOriginReference:FLOW_ORIGIN});
      // An explicit bind starts a new session only if the previous automation differs.
      if(current.botPublicId!==id||current.botOriginReference!==FLOW_ORIGIN)await tx.query('delete from flow_sessions s using messaging_conversations c where s.organization_id=$1 and c.organization_id=s.organization_id and c.id=s.conversation_id and c.channel_id=$2',[org,channelId]);
      return {channelId:result.id,flowId:id};
    }),
    unbind:(org:string,id:string,channelId:string)=>transact(org,async tx=>{
      await feature(tx,org);await get(tx,org,id);
      const current=await messaging.findChannel(tx,org,channelId);
      if(!current||current.botPublicId!==id||current.botOriginReference!==FLOW_ORIGIN)throw new FlowError('FLOW_BINDING_NOT_FOUND',404);
      await messaging.setChannelBot(tx,{organizationId:org,channelId,botPublicId:null,botOriginReference:null});return {ok:true};
    }),
    runs:(org:string,id:string)=>transact(org,async tx=>{
      await feature(tx,org);await get(tx,org,id);
      return {data:(await tx.query('select message_id AS id,conversation_id AS "conversationId",version,status,trace,error_code AS "errorCode",created_at AS "createdAt" from flow_runs where organization_id=$1 and flow_id=$2 order by created_at desc limit 100',[org,id])).rows};
    }),
    settleHandoffs:(org:string)=>transact(org,async tx=>{
      const rows=await tx.query(`select s.conversation_id from flow_sessions s join messaging_conversations c on c.organization_id=s.organization_id and c.id=s.conversation_id
        where s.organization_id=$1 and s.state->>'status'='handoff' and c.mode='BOT'
        and not exists(select 1 from messaging_messages m join flow_outputs o on o.organization_id=m.organization_id and o.message_id=m.id
          where m.organization_id=s.organization_id and m.conversation_id=s.conversation_id and m.state in ('ACCEPTED','SENDING'))`,[org]);
      for(const row of rows.rows)await messaging.setConversationMode(tx,{organizationId:org,conversationId:row.conversation_id,mode:'HUMAN'});
    }),
    // Pure native nodes have no remote side effects. State, audit and output enqueue commit together.
    runTurn:(claim:BotTurnClaim)=>transact(claim.message.organizationId,async tx=>{
      const org=claim.message.organizationId,key={organizationId:org,messageId:claim.message.id,leaseToken:claim.leaseToken};
      let config:Feature;
      try{config=await feature(tx,org);}catch{
        await messaging.failBotTurn(tx,{...key,canonicalErrorCode:'FLOWS_DISABLED',uncertain:false});return;
      }
      const current=(await tx.query(`select c.* from messaging_conversations c join messaging_bot_jobs j on j.organization_id=c.organization_id and j.conversation_id=c.id
        where c.organization_id=$1 and c.id=$2 and j.message_id=$3 and j.lease_token=$4 and j.status='RUNNING' and j.lease_expires_at>now() for update of c,j`,[org,claim.conversation.id,claim.message.id,claim.leaseToken])).rows[0];
      if(!current)return;
      if(current.bot_origin_reference!==FLOW_ORIGIN||current.bot_public_id!==claim.conversation.botPublicId||claim.message.createdAt<config.updated_at){
        await messaging.failBotTurn(tx,{...key,canonicalErrorCode:'FLOW_BINDING_CHANGED',uncertain:false});return;
      }
      const flow=await get(tx,org,current.bot_public_id);
      const stored=(await tx.query('select * from flow_sessions where organization_id=$1 and conversation_id=$2',[org,claim.conversation.id])).rows[0];
      if(stored?.state?.status==='handoff'){
        await messaging.completeBotTurn(tx,{...key,sessionId:'flow:'+flow.id,texts:[]});return;
      }
      if(stored&&stored.feature_revision!==config.revision){
        await messaging.failBotTurn(tx,{...key,canonicalErrorCode:'FLOW_SESSION_REVOKED',uncertain:false});return;
      }
      const state:FlowState|undefined=stored?.state?.status==='waiting'?stored.state:undefined;
      const version:number=state?stored.version:flow.publishedVersion!;
      const record=(await tx.query('select graph from flow_versions where organization_id=$1 and flow_id=$2 and version=$3',[org,flow.id,version])).rows[0];
      if(!record)throw new FlowError('FLOW_NOT_PUBLISHED',409);
      let result;
      try{
        result=executeFlow(record.graph,{text:claim.message.content.type==='TEXT'?claim.message.content.text:'',variables:{'contact.name':claim.contact.displayName??'cliente'},...(state?{state}:{})});
      }catch{
        await messaging.failBotTurn(tx,{...key,canonicalErrorCode:'FLOW_EXECUTION_FAILED',uncertain:false});
        await tx.query(`insert into flow_runs(organization_id,message_id,conversation_id,flow_id,version,feature_revision,status,error_code) values($1,$2,$3,$4,$5,$6,'failed','FLOW_EXECUTION_FAILED')`,[org,claim.message.id,claim.conversation.id,flow.id,version,config.revision]);return;
      }
      const completion=await messaging.completeBotTurn(tx,{...key,sessionId:'flow:'+flow.id+':'+version,texts:result.texts});
      const status=completion.kind==='paused'?'paused':result.status;
      await tx.query('insert into flow_runs(organization_id,message_id,conversation_id,flow_id,version,feature_revision,status,trace) values($1,$2,$3,$4,$5,$6,$7,$8)',[org,claim.message.id,claim.conversation.id,flow.id,version,config.revision,status,JSON.stringify(result.trace)]);
      if(completion.kind==='paused')return;
      await tx.query(`insert into flow_sessions(organization_id,conversation_id,flow_id,version,feature_revision,state) values($1,$2,$3,$4,$5,$6)
        on conflict(organization_id,conversation_id) do update set flow_id=$3,version=$4,feature_revision=$5,state=$6,updated_at=now()`,[org,claim.conversation.id,flow.id,version,config.revision,JSON.stringify({status:result.status,nodeId:result.nodeId,variables:result.variables,steps:result.steps})]);
      for(const output of completion.messages)await tx.query('insert into flow_outputs(organization_id,message_id,incoming_message_id) values($1,$2,$3)',[org,output.id,claim.message.id]);
      if(result.status==='handoff'&&!completion.messages.length)await messaging.setConversationMode(tx,{organizationId:org,conversationId:claim.conversation.id,mode:'HUMAN'});
    }),
  };
  return service;
}
