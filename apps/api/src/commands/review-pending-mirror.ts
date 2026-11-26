import {parseArgs} from 'node:util';
import {Pool} from 'pg';
import {z} from 'zod';
import {withOrganizationTransaction} from '../db/tenant-transaction.js';
import {loadIntegrationConfig} from '../modules/integrations/runtime.js';
import {chatwootEnvironment} from '../modules/integrations/chatwoot-service.js';
import {inspectMirrorQueue,reviewPendingMirror} from '../modules/integrations/review-pending-mirror.js';
import type {ChatwootOptions} from '../modules/integrations/chatwoot-service.js';

async function run(){
 const {values}=parseArgs({options:{
   org:{type:'string'},integration:{type:'string'},job:{type:'string'},message:{type:'string'},
   account:{type:'string'},inbox:{type:'string'},conversation:{type:'string'},approve:{type:'string'},diagnose:{type:'boolean'},
 }});
 const config=loadIntegrationConfig(process.env).chatwoot;
 if(!config)throw new Error('CHATWOOT_NOT_CONFIGURED');
 const db=z.url().parse(process.env.DATABASE_URL);
 if(new URL(db).username!=='jrc_app')throw new Error('REVIEW_REQUIRES_APP_ROLE');
 const pool=new Pool({connectionString:db,max:2,connectionTimeoutMillis:5000,statement_timeout:15000});
 try{
   if(values.diagnose&&values.approve)throw new Error('INVALID_REVIEW_MODE');
   const transact:ChatwootOptions['transact']=(org,work)=>withOrganizationTransaction(pool,org,work);
   const input={
     organizationId:z.uuid().parse(values.org),integrationId:z.uuid().parse(values.integration),
     jobId:z.uuid().parse(values.job),messageId:z.uuid().parse(values.message),
     accountId:Number(values.account),inboxId:Number(values.inbox),conversationId:Number(values.conversation),
   };
   const client=chatwootEnvironment({...config,transact,resolveIntegration:async()=>undefined}).client;
   const result=values.diagnose?await inspectMirrorQueue(transact,input):await reviewPendingMirror({transact,client},input,values.approve);
   process.stdout.write(JSON.stringify(result)+'\n');
 }finally{await pool.end();}
}
run().catch((error:unknown)=>{
 const code=error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'MIRROR_REVIEW_FAILED';
 process.stderr.write(code+'\n');
 process.exitCode=1;
});
