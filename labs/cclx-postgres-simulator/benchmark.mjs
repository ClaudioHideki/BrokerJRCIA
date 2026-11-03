import { createHash, createHmac } from 'node:crypto';
import { cpus, totalmem, freemem, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedLabDatabase, createPrivateMediaState, requireLabOnly } from './state.mjs';
import { openLabReceiver, LAB_ORGANIZATIONS, LAB_SECRET } from './receiver.mjs';
import { reconcilePersistedIdentities } from './identity-reconciliation.mjs';

const DEFAULT_COUNTS=Object.freeze([50,100,200,400]);
const rounded=value=>Number(value.toFixed(3));
const percentile=(values,p)=>values[Math.max(0,Math.ceil(values.length*p)-1)]??0;

/** A finite count of synthetic events, never physical sessions or external traffic. */
export async function runBenchmark(options={}){
  requireLabOnly(options);
  const counts=options.counts??DEFAULT_COUNTS,concurrency=options.concurrency??4;
  if(Object.keys(options).some(key=>!['labOnly','counts','concurrency'].includes(key))||!Array.isArray(counts)||!counts.length||counts.length>4||
    counts.some(count=>!Number.isSafeInteger(count)||count<1||count>400)||counts.reduce((sum,count)=>sum+count,0)>750||
    !Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4)throw Error('INVALID_BENCHMARK_OPTIONS');
  const memoryAtStart=freemem(),startedAt=new Date().toISOString(),started=performance.now();
  let database,mediaState,receiver;
  try{
    database=await createIsolatedLabDatabase({labOnly:true});mediaState=await createPrivateMediaState({labOnly:true});
    receiver=await openLabReceiver({labOnly:true,database,mediaState});
    const postgres=(await database.query("SELECT current_setting('server_version') version,current_setting('fsync') fsync,current_setting('full_page_writes') full_page_writes")).rows[0];
    const stages=[],expected=[],totals={uniqueEvents:0,requests:0,accepted:0,duplicates:0,errors:0};let offset=0;
    for(const count of counts){
      const tasks=[],expectedDuplicates=Math.floor(count/10),latencies=[],errors=[];
      const tenantMetrics=new Map(LAB_ORGANIZATIONS.map(organizationId=>[organizationId,
        {organizationId,requests:0,accepted:0,duplicates:0,errors:0,latencies:[]}]));
      for(let index=0;index<count;index++){
        const sequence=350000+offset+index,organizationId=LAB_ORGANIZATIONS[index%2];
        // Deliberately collide event IDs between the two consumers. Tenant is
        // part of the durable identity; aggregate row counts cannot prove it.
        const eventId=`00000000-0000-4000-8000-${String(350000+offset+Math.floor(index/2)).padStart(12,'0')}`;
        const envelope={schemaVersion:1,eventId,cursor:String(sequence),organizationId,
          type:'message.received',occurredAt:startedAt,data:{labFixture:true,sequence}};
        const rawBody=Buffer.from(JSON.stringify(envelope));
        expected.push({organizationId,eventId,sequence,cursor:String(sequence),envelope,
          bodyHash:createHash('sha256').update(rawBody).digest('hex')});
        const task={eventId,organizationId,rawBody};tasks.push(task);
        if(index<expectedDuplicates)tasks.push(task);
      }
      let next=0,accepted=0,duplicates=0;const stageStart=performance.now();
      async function worker(){
        while(next<tasks.length){
          const task=tasks[next++],timestamp=String(Math.floor(Date.now()/1000)),requestStart=performance.now();
          const tenant=tenantMetrics.get(task.organizationId);tenant.requests++;
          try{
            const result=await receiver.handle({method:'POST',path:'/lab/cclx/events',rawBody:task.rawBody,headers:{'content-type':'application/json',
              'x-jrc-event-id':task.eventId,'x-jrc-timestamp':timestamp,'x-jrc-signature':'sha256='+createHmac('sha256',LAB_SECRET).update(`${timestamp}.${task.eventId}.`).update(task.rawBody).digest('hex')}});
            if(result.status===202&&result.body.duplicate===false){accepted++;tenant.accepted++;}
            else if(result.status===202&&result.body.duplicate===true){duplicates++;tenant.duplicates++;}
            else {tenant.errors++;errors.push({status:result.status,code:/^[A-Z0-9_]{1,64}$/.test(result.body?.code)?result.body.code:'LAB_ERROR'});}
          }catch{tenant.errors++;errors.push({status:null,code:'INJECTED_REQUEST_FAILED'});}
          finally{const latency=performance.now()-requestStart;latencies.push(latency);tenant.latencies.push(latency);}
        }
      }
      await Promise.all(Array.from({length:Math.min(concurrency,tasks.length)},worker));
      const duration=performance.now()-stageStart,rows=await receiver.stats();offset+=count;latencies.sort((a,b)=>a-b);
      // Read SQL through the fixture owner, independently of receiver ACKs or
      // stats. No customer tables, application role or remote endpoint is used.
      const persistedInbox=(await database.query(`SELECT organization_id AS "organizationId", event_id AS "eventId",
        body_hash AS "bodyHash", envelope->>'cursor' AS cursor, envelope->'data'->'sequence' AS sequence, envelope
        FROM cclx_lab_inbox`)).rows;
      const persistedProjections=(await database.query(`SELECT organization_id AS "organizationId", event_id AS "eventId",
        sequence::integer AS sequence FROM cclx_lab_projections`)).rows;
      const identityAudit=reconcilePersistedIdentities(expected,persistedInbox,persistedProjections);
      const tenants=[...tenantMetrics.values()].map(({latencies:values,...metric})=>{
        values.sort((a,b)=>a-b);
        return {...metric,p50Ms:rounded(percentile(values,0.5)),p95Ms:rounded(percentile(values,0.95)),
          maxMs:rounded(values.at(-1)??0),latencySamples:values.length};
      });
      stages.push({uniqueEvents:count,expectedDuplicates,requests:tasks.length,accepted,duplicates,errors:errors.length,errorDetails:errors,
        p50Ms:rounded(percentile(latencies,0.50)),p95Ms:rounded(percentile(latencies,0.95)),maxMs:rounded(latencies.at(-1)??0),totalMs:rounded(duration),
        tenants,identityAudit,cumulativeRows:rows,
        reconciled:accepted===count&&duplicates===expectedDuplicates&&!errors.length&&rows.inbox===offset&&rows.projections===offset&&identityAudit.reconciled});
      totals.uniqueEvents+=count;totals.requests+=tasks.length;totals.accepted+=accepted;totals.duplicates+=duplicates;totals.errors+=errors.length;
    }
    const rows=await receiver.stats();
    return {kind:'CCLX_PG_FINITE_SYNTHETIC_EVENT_BENCHMARK',countsAre:'SYNTHETIC_EVENTS_NOT_SESSIONS',startedAt,
      command:'node labs/cclx-postgres-simulator/benchmark.mjs --lab-only',counts:[...counts],concurrency,
      duplicatePolicy:'floor(uniqueEvents / 10) per stage; exactly 10% for the default 50/100/200/400 stages',
      identityPolicy:'Independent source manifest versus SQL tenant/event IDs, hashes, complete envelopes and projections; event IDs intentionally collide between tenants',
      latencyScope:'ALL_INJECTED_REQUESTS_INCLUDING_DUPLICATES; stages exclude database setup and cleanup',
      stages,totals,rows,reconciled:stages.every(stage=>stage.reconciled),endingBacklog:null,backlogMeaning:'NO_QUEUE_IN_THIS_LAB',
      totalMs:rounded(performance.now()-started),capacityGo:false,
      scope:{injectedReceiver:true,realPostgres:true,externalRequests:0,engineSessions:0,whatsappSessions:0,mediaBenchmark:false,
        measured250000MessagesPerDay:false,sloValidated:false},
      hardware:{node:process.version,platform:platform(),architecture:arch(),cpuModel:cpus()[0]?.model??null,logicalCpus:cpus().length,
        totalMemoryBytes:totalmem(),freeMemoryBytesAtStart:memoryAtStart,freeMemoryBytesAtEnd:freemem(),postgres,
        postgresContainerLimits:'NOT_COLLECTED_BY_THIS_HARNESS',resourceContention:'NOT_CONTROLLED; local functional measurement only'},
    };
  }finally{await receiver?.close();await database?.dispose();await mediaState?.dispose();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--lab-only')throw Error('LAB_ARGUMENTS_ONLY');
    const report=await runBenchmark({labOnly:true});process.stdout.write(JSON.stringify(report,null,2)+'\n');
    if(!report.reconciled)process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
