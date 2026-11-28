import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { z } from 'zod';
import { withOrganizationTransaction } from '../db/tenant-transaction.js';
import { reconcileDirectReplyFromStores } from '../modules/integrations/reconcile-direct-reply.js';

async function run(){
  const {values}=parseArgs({options:{org:{type:'string'},job:{type:'string'},proof:{type:'string'},
    apply:{type:'string'},receipt:{type:'boolean'}}});
  const organizationId=z.uuid().parse(values.org),jobId=z.uuid().parse(values.job);
  if(values.apply!==undefined && values.apply!==jobId)throw new Error('DIRECT_RECEIPT_APPROVAL_MISMATCH');
  if(values.receipt&&!values.apply)throw new Error('DIRECT_RECEIPT_REQUIRES_COMMIT');
  const [proof,custody]=await Promise.all([
    readFile(z.string().min(1).parse(values.proof)),
    readFile(z.string().min(1).parse(process.env.CHATWOOT_DIRECT_CUSTODY_FILE))
  ]);
  const custodyHash=z.string().regex(/^[0-9a-f]{64}$/).parse(process.env.CHATWOOT_DIRECT_CUSTODY_SHA256);
  const poolFor=(url:unknown)=>new Pool({connectionString:z.url().parse(url),max:1,connectionTimeoutMillis:5000,statement_timeout:15000});
  const pool=poolFor(process.env.DATABASE_URL);
  const rails=poolFor(process.env.CHATWOOT_DIRECT_RAILS_READ_URL),evolution=poolFor(process.env.CHATWOOT_DIRECT_EVOLUTION_READ_URL);
  const dryRun=new Error('DIRECT_RECEIPT_PREVIEW');
  try{
    let summary='INCONCLUSIVE';
    try{
      const committed=await withOrganizationTransaction(pool,organizationId,async tx=>{
        const result=await reconcileDirectReplyFromStores(tx,proof,custody,custodyHash,rails,evolution,{organizationId,jobId});
        if(!new Set((process.env.CHATWOOT_DIRECT_TRANSPORT_REVIEW_INTEGRATIONS??'').split(',').map(x=>x.trim())).has(result.receipt.integrationId))
          throw new Error('DIRECT_RECEIPT_REVIEW_HOLD_REQUIRED');
        summary=result.result;
        if(!values.apply)throw dryRun;
        return result;
      });
      process.stdout.write(JSON.stringify(values.receipt?committed:{result:committed.result})+'\n');
    }catch(error){
      if(error!==dryRun)throw error;
      process.stdout.write(JSON.stringify({preview:summary})+'\n');
    }
  }finally{await Promise.all([pool.end(),rails.end(),evolution.end()]);}
}
run().catch((error:unknown)=>{
  process.stderr.write((error instanceof Error && /^DIRECT_[A-Z_]+$/.test(error.message)?error.message:'DIRECT_RECEIPT_REJECTED')+'\n');
  process.exitCode=1;
});
