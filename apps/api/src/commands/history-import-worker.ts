import {pathToFileURL} from 'node:url';
import {setTimeout} from 'node:timers/promises';
import {Pool} from 'pg';
import {loadDatabasePoolBudget} from '../db/pool-budget.js';
import {z} from 'zod';
import {withOrganizationTransaction} from '../db/tenant-transaction.js';
import {scanOperationalOrganizations} from './automation-worker.js';
import {createEvolutionFleetRuntime} from '../modules/evolution-fleet/runtime.js';
import {createHistorySourceRuntime} from '../modules/history-import/runtime.js';
import {createHistoryImportService} from '../modules/history-import/service.js';
import {createHistoryImportWorker} from '../modules/history-import/worker.js';

/** Dedicated bulk worker: historical imports never occupy the scheduler's bot/wait loop. */
export async function runHistoryImportWorker(environment:NodeJS.ProcessEnv=process.env,watch=false){
 const databaseUrl=z.string().url().parse(environment.DATABASE_URL);
 if(new URL(databaseUrl).username!=='jrc_app')throw new Error('HISTORY_WORKER_REQUIRES_APP_ROLE');
 const interval=z.coerce.number().int().min(1000).max(60000).default(5000).parse(environment.HISTORY_IMPORT_WORKER_INTERVAL_MS);
 const pool=new Pool({connectionString:databaseUrl,...loadDatabasePoolBudget(environment,'HISTORY_IMPORT_WORKER'),statement_timeout:30000});
 const abort=new AbortController(),stop=()=>abort.abort();
 const transact=<T>(org:string,work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(pool,org,work);
 let runtime:ReturnType<typeof createHistorySourceRuntime>|undefined;
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  if(environment.HISTORY_EVOLUTION_DATABASE_URL||environment.HISTORY_EVOLUTION_DATABASES_JSON)
   runtime=createHistorySourceRuntime(environment,createEvolutionFleetRuntime(environment,transact),transact);
  const worker=runtime?.source?createHistoryImportWorker({transact,service:createHistoryImportService({transact,source:runtime.source})}):undefined;
  do{
   if(worker)await scanOperationalOrganizations(async(cursor,batch)=>(await pool.query<{organization_id:string}>(
    'SELECT * FROM operational_worker_organizations($1,$2)',[cursor,batch])).rows.map(row=>row.organization_id),
    org=>worker.runOnce(org,abort.signal),abort.signal,()=>process.stderr.write('HISTORY_IMPORT_ORGANIZATION_FAILED\n'));
   if(watch&&!abort.signal.aborted)await setTimeout(interval,undefined,{signal:abort.signal}).catch(()=>undefined);
  }while(watch&&!abort.signal.aborted);
 }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);await runtime?.close();await pool.end();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)
 runHistoryImportWorker(process.env,process.argv.includes('--watch')).catch(()=>{process.stderr.write('HISTORY_IMPORT_WORKER_FAILED\n');process.exitCode=1;});
