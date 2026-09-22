import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { withOrganizationTransaction } from '../db/tenant-transaction.js';
import { createExecutionService, createOutboxDispatcher } from '../modules/automations/service.js';
import { createPostgresAutomationRepository } from '../modules/automations/repository.js';
import { createPostgresMessagingRepository } from '../modules/messaging/repository.js';
import { recordHeartbeat, workerInstanceId } from '../modules/observability/service.js';

export function loadAutomationWorkerConfig(environment:NodeJS.ProcessEnv){const databaseUrl=z.string().url().parse(environment.DATABASE_URL);
  if(new URL(databaseUrl).username!=='jrc_app')throw new Error('AUTOMATION_WORKER_REQUIRES_APP_ROLE');return {databaseUrl,intervalMs:z.coerce.number().int().min(100).max(60000).default(1000).parse(environment.AUTOMATION_WORKER_INTERVAL_MS)};}
export async function runAutomationWorker(environment:NodeJS.ProcessEnv=process.env,watch=false){const config=loadAutomationWorkerConfig(environment),pool=new Pool({connectionString:config.databaseUrl,max:4,connectionTimeoutMillis:5000,statement_timeout:30000});
  const instanceId=workerInstanceId();
  const repository=createPostgresAutomationRepository(),transact=<T>(org:string,work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(pool,org,work),execution=createExecutionService({transact,repository});
  const messaging=createPostgresMessagingRepository(),outbox=createOutboxDispatcher({transact,repository},{dispatch:async item=>{
    if(!item.conversationId)return {kind:'FAILED' as const,error:'AUTOMATION_CONVERSATION_REQUIRED'};
    try{if(item.kind==='HANDOFF'){await transact(item.organizationId,tx=>messaging.setConversationMode(tx,{organizationId:item.organizationId,conversationId:item.conversationId!,mode:'HUMAN'}));return {kind:'SENT' as const,remoteReference:`handoff:${item.conversationId}`};}
      const text=typeof item.payload.text==='string'?item.payload.text:'';if(!text)return {kind:'FAILED' as const,error:'AUTOMATION_TEXT_REQUIRED'};
      const queued=await transact(item.organizationId,tx=>messaging.enqueueOutgoing(tx,{id:randomUUID(),organizationId:item.organizationId,channelId:item.channelId,conversationId:item.conversationId!,source:'AUTOMATION',content:{type:'TEXT',text},idempotencyKey:`automation:${item.id}`,bodyHash:createHash('sha256').update(text).digest('hex'),policy:{requireOptIn:false}}));
      return {kind:'SENT' as const,remoteReference:queued.message.id};
    }catch(error){const code=error instanceof Error?error.message:'AUTOMATION_EFFECT_FAILED';return ['CONVERSATION_PAUSED','CONTACT_SUPPRESSED','CONTACT_CONSENT_REQUIRED'].includes(code)?{kind:'FAILED' as const,error:code}:{kind:'NOT_SENT' as const,error:code,retryAt:new Date(Date.now()+30000)};}
  }});
  const abort=new AbortController(),stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{do{const organizations=(await pool.query<{organization_id:string}>('select * from operational_worker_organizations(null,1000)')).rows.map(row=>row.organization_id);
    for(const org of organizations){if(abort.signal.aborted)break;await transact(org,tx=>recordHeartbeat(tx,org,'AUTOMATION_WORKER',instanceId));await execution.runOnce(org);await outbox.runOnce(org);}if(watch&&!abort.signal.aborted)await setTimeout(config.intervalMs,undefined,{signal:abort.signal}).catch(()=>undefined);
  }while(watch&&!abort.signal.aborted);}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);await pool.end();}}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)runAutomationWorker(process.env,process.argv.includes('--watch')).catch(()=>{process.stderr.write('AUTOMATION_WORKER_FAILED\n');process.exitCode=1;});
