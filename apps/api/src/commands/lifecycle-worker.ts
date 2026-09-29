import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { EvolutionProviderAdapter } from '@jrc/providers';
import { createLifecycleService, withLifecycleWorkerTransaction } from '../modules/lifecycle/service.js';

export async function runLifecycleWorker(environment:NodeJS.ProcessEnv=process.env,watch=false){
  const url=z.string().url().parse(environment.LIFECYCLE_DATABASE_URL);
  if(new URL(url).username!=='jrc_lifecycle')throw new Error('LIFECYCLE_WORKER_REQUIRES_DEDICATED_ROLE');
  const interval=z.coerce.number().int().min(500).max(60000).default(3000).parse(environment.LIFECYCLE_WORKER_INTERVAL_MS);
  const provider=new EvolutionProviderAdapter({baseUrl:z.string().url().parse(environment.EVOLUTION_BASE_URL),
    apiKey:z.string().min(1).parse(environment.EVOLUTION_API_KEY)});
  const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:5000,statement_timeout:600000});
  const service=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(pool,work),
    deprovision:async(organizationId,upstreamKey)=>{
      const controller=new AbortController();
      await provider.deprovisionInstance({organizationId,requestId:randomUUID(),deadline:new Date(Date.now()+30000),
        signal:controller.signal},{id:upstreamKey});
    }});
  const stop=new AbortController(),abort=()=>stop.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try{
    do{
      try{const worked=await service.processOne();if(worked)continue;}
      catch{process.stderr.write('LIFECYCLE_OPERATION_FAILED\n');}
      if(watch&&!stop.signal.aborted)await wait(interval,undefined,{signal:stop.signal}).catch(()=>undefined);
    }while(watch&&!stop.signal.aborted);
  }finally{process.off('SIGINT',abort);process.off('SIGTERM',abort);await pool.end();}
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)
  runLifecycleWorker(process.env,process.argv.includes('--watch')).catch(()=>{process.stderr.write('LIFECYCLE_WORKER_FAILED\n');process.exitCode=1;});
