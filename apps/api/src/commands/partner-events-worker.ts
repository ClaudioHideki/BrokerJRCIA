import {pathToFileURL} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {Pool} from 'pg';
import {z} from 'zod';
import {withOrganizationTransaction} from '../db/tenant-transaction.js';
import {loadDatabasePoolBudget} from '../db/pool-budget.js';
import {createIntegrationSecrets} from '../modules/integrations/secrets.js';
import {createPartnerEventWorker} from '../modules/partner-events/worker.js';

export function loadPartnerEventsWorkerConfig(environment:NodeJS.ProcessEnv){
 const databaseUrl=z.string().url().parse(environment.DATABASE_URL);
 if(new URL(databaseUrl).username!=='jrc_app')throw new Error('PARTNER_WORKER_REQUIRES_APP_ROLE');
 const encryptionKey=z.string().min(1).parse(environment.PARTNER_WEBHOOK_ENCRYPTION_KEY);
 createIntegrationSecrets(encryptionKey);
 return {databaseUrl,encryptionKey,intervalMs:z.coerce.number().int().min(100).max(60000).default(1000).parse(environment.PARTNER_EVENTS_WORKER_INTERVAL_MS)};
}
export async function runPartnerEventsWorker(environment:NodeJS.ProcessEnv=process.env,watch=false){
 const config=loadPartnerEventsWorkerConfig(environment),secrets=createIntegrationSecrets(config.encryptionKey);
 const poolBudget=loadDatabasePoolBudget(environment,'PARTNER_EVENTS_WORKER');
 const pool=new Pool({connectionString:config.databaseUrl,...poolBudget,statement_timeout:30000});
 const worker=createPartnerEventWorker({transact:(org,work)=>withOrganizationTransaction(pool,org,work),
  openSecret:claim=>secrets.decrypt(`partner-webhook:${claim.organizationId}:${claim.endpointId}`,claim.encryptedSecret)});
 const stop=new AbortController(),abort=()=>stop.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
 try{do{
  // One claim per tenant per complete discovery round. Preserve the twenty
  // delivery budget, but do not let a large tenant consume it before its peers.
  // At most two independent tenants can dispatch, within the existing DB pool
  // budget. A single tenant remains sequential; claim/lease fencing is unchanged.
  for(let round=0;round<20&&!stop.signal.aborted;round++){
   let cursor:string|null=null,more:boolean,worked=false;
   do{
    const organizations:Array<{organization_id:string}>=(await pool.query<{organization_id:string}>('SELECT * FROM partner_event_worker_organizations($1,$2)',[cursor,100])).rows;
    more=organizations.length===100;cursor=organizations.at(-1)?.organization_id??cursor;
    let next=0;
    const consume=async()=>{
     while(!stop.signal.aborted){
      const row=organizations[next++];if(!row)return;
      try{
       // Retention still visits suspended organizations once per scan. Active
       // deliveries publish under processOne's own tenant transaction as before.
       if(round===0)await withOrganizationTransaction(pool,row.organization_id,tx=>tx.query('SELECT partner_publish_events()'));
       if(stop.signal.aborted)return;
       if(await worker.processOne(row.organization_id))worked=true;
      }catch{process.stderr.write('PARTNER_EVENT_DELIVERY_FAILED\n');}
     }
    };
    await Promise.all(Array.from({length:Math.min(poolBudget.max,2,organizations.length)},consume));
   }while(more&&!stop.signal.aborted);
   if(!worked)break;
  }
  if(watch&&!stop.signal.aborted)await wait(config.intervalMs,undefined,{signal:stop.signal}).catch(()=>undefined);
 }while(watch&&!stop.signal.aborted);
 }finally{process.off('SIGINT',abort);process.off('SIGTERM',abort);await pool.end();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)
 runPartnerEventsWorker(process.env,process.argv.includes('--watch')).catch(()=>{process.stderr.write('PARTNER_EVENTS_WORKER_FAILED\n');process.exitCode=1;});
