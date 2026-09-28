import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { withOrganizationTransaction } from '../db/tenant-transaction.js';
import { createExecutionService } from '../modules/automations/service.js';
import { createPostgresAutomationRepository } from '../modules/automations/repository.js';
import { recordHeartbeat, workerInstanceId } from '../modules/observability/service.js';
import { scanOperationalOrganizations } from './automation-worker.js';

export async function runSchedulerWorker(environment:NodeJS.ProcessEnv=process.env,watch=false){const databaseUrl=z.string().url().parse(environment.DATABASE_URL);if(new URL(databaseUrl).username!=='jrc_app')throw new Error('SCHEDULER_WORKER_REQUIRES_APP_ROLE');
  const interval=z.coerce.number().int().min(100).max(60000).default(1000).parse(environment.SCHEDULER_WORKER_INTERVAL_MS),pool=new Pool({connectionString:databaseUrl,max:2,connectionTimeoutMillis:5000,statement_timeout:30000}),repository=createPostgresAutomationRepository();
  const transact=<T>(org:string,work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(pool,org,work),execution=createExecutionService({repository,transact}),abort=new AbortController(),stop=()=>abort.abort(),instanceId=workerInstanceId();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{do{await scanOperationalOrganizations(async(cursor,batchSize)=>(await pool.query<{organization_id:string}>('select * from operational_worker_organizations($1,$2)',[cursor,batchSize])).rows.map(row=>row.organization_id),async org=>{await transact(org,tx=>recordHeartbeat(tx,org,'SCHEDULER',instanceId));await execution.releaseDueWaits(org);},abort.signal,(_error,org)=>process.stderr.write(JSON.stringify({event:'SCHEDULER_ORGANIZATION_FAILED',organizationId:org})+'\n'));if(watch&&!abort.signal.aborted)await setTimeout(interval,undefined,{signal:abort.signal}).catch(()=>undefined);}while(watch&&!abort.signal.aborted);}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);await pool.end();}}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)runSchedulerWorker(process.env,process.argv.includes('--watch')).catch(()=>{process.stderr.write('SCHEDULER_WORKER_FAILED\n');process.exitCode=1;});
