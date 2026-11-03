import {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {validateSourceCrashFixture} from './media-source-process.mjs';
import {withOrganizationTransaction} from '../../apps/api/dist/db/tenant-transaction.js';
import {createMediaStore} from '../../apps/api/dist/modules/messaging/media-store.js';
import {createDurablePrivateMediaStore} from '../../apps/api/dist/modules/messaging/durable-private-media.js';
import {createS3PrivateObjectStore} from '../../apps/api/dist/modules/messaging/private-object-store.js';

if(!process.send||process.env.NODE_ENV!=='test')process.exit(2);
process.on('disconnect',()=>process.exit(1));
process.once('message',async options=>{
 let markerPool,pool;
 try {
  validateSourceCrashFixture(options);
  markerPool=new Pool({connectionString:options.database.connectionString,max:1,connectionTimeoutMillis:3000,statement_timeout:5000});
  const markers=(await markerPool.query('SELECT token FROM cclx_fixture.cclx_lab_marker')).rows;
  if(markers.length!==1||markers[0].token!==options.database.token)throw Error('MARKER_MISMATCH');
  const {organizationId:org,channelId,mediaId}=options.scope;
  const recovering=options.mode==='RECONCILE';
  const entries=(await markerPool.query('SELECT organization_id,channel_id,id,status,source,source_key FROM messaging_media')).rows;
  if(entries.length!==1||entries[0].organization_id!==org||entries[0].channel_id!==channelId||entries[0].id!==mediaId||
   entries[0].status!==(recovering?'STORING':'PENDING')||entries[0].source!=='META'||entries[0].source_key!=='synthetic-worker-media')throw Error('SYNTHETIC_SOURCE_MISMATCH');
  await markerPool.end();markerPool=undefined;
  const url=new URL(options.database.connectionString);url.username='jrc_app';url.password='';
  pool=new Pool({connectionString:url.href,max:2,connectionTimeoutMillis:3000,statement_timeout:10000});
  const transact=(tenant,work)=>{if(tenant!==org)throw Error('TENANT_REFUSED');return withOrganizationTransaction(pool,tenant,work);};
  const adapter=createS3PrivateObjectStore({...options.s3,profile:'broker-lab',region:'us-east-1',dedicatedBucket:true,allowLoopbackHttpForTests:true});
  let sourcePuts=0,providerDownloads=0;
  const sourcePort={destinationFingerprint:adapter.destinationFingerprint,
   async put(...args){sourcePuts++;if(recovering)throw Error('RECOVERY_MUST_NOT_REPEAT_PUT');const result=await adapter.put(...args);if(result.outcome!=='CONFIRMED')throw Error('PUT_NOT_CONFIRMED');
    process.send({kind:'PUT_PERSISTED',sourcePuts,providerDownloads});
    // Intentional crash point after the external side effect and before its SQL settlement.
    await new Promise(()=>{});
   },read:(...args)=>adapter.read(...args),inspect:(...args)=>adapter.inspect(...args),remove:()=>{throw Error('KEEP_MUST_NOT_DELETE');}};
  const encryptionKey=Buffer.alloc(32,32).toString('base64');
  const media=createMediaStore({transact,encryptionKey,download:async()=>{providerDownloads++;if(recovering)throw Error('RECOVERY_MUST_NOT_DOWNLOAD');return {
   bytes:new Uint8Array(Buffer.from('%PDF-1.4\nsynthetic worker custody fixture\n%%EOF')),
   mimeType:'application/pdf',kind:'document',fileName:'synthetic-worker.pdf'};},
   privateStore:createDurablePrivateMediaStore({transact,encryptionKey,profile:'broker-lab',objectStore:sourcePort,
    requestTimeoutMs:3000,cleanupTransact:()=>{throw Error('CLEANUP_OUT_OF_SCOPE');}})});
  await media.runOnce(org);
  if(recovering){
   const value=await media.read(org,mediaId);
   const sha256=createHash('sha256').update(value.bytes).digest('hex');
   await pool.end();pool=undefined;
   process.send({kind:'RECOVERY_COMPLETED',sourcePuts,providerDownloads,sha256},()=>process.exit(0));
   return;
  }
  throw Error('EXPECTED_CRASH_POINT_MISSING');
 } catch {
  await markerPool?.end();await pool?.end();
  process.send({kind:'FAILED'},()=>process.exit(1));
 }
});
