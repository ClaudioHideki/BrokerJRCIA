import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createChatwootService} from '../../src/modules/integrations/chatwoot-service.js';
import {createMediaStore,registerPendingMedia} from '../../src/modules/messaging/media-store.js';
import {createDurablePrivateMediaStore} from '../../src/modules/messaging/durable-private-media.js';
import {createS3PrivateObjectStore,type PrivateObjectStore} from '../../src/modules/messaging/private-object-store.js';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
const encryptionKey=Buffer.alloc(32,7).toString('base64');
const file={bytes:new Uint8Array(Buffer.from('synthetic')),mimeType:'application/pdf',kind:'document' as const,fileName:'synthetic.pdf'};
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();});
afterAll(async()=>{await db?.dispose();});
async function fixture(){
 const tenant=await seedAttendanceTenant(db.database),id=await db.transact(tenant.org,tx=>registerPendingMedia(tx,tenant.org,tenant.channel,
  {source:'META',sourceKey:randomUUID(),kind:'document',fileName:file.fileName,descriptor:{mediaId:'11111'}}));
 const message=randomUUID(),job=randomUUID();
 await db.database.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state)
  VALUES($1,$2,$3,$4,'INCOMING','CONTACT',$5,'DELIVERED')`,[message,tenant.org,tenant.channel,tenant.conversation,JSON.stringify({type:'MEDIA',kind:'document',mediaId:id,fileName:file.fileName})]);
 await db.database.pool.query(`INSERT INTO integration_jobs(id,organization_id,integration_id,kind,dedupe_key,message_id,status,last_error)
  VALUES($1,$2,$3,'MIRROR_MESSAGE',$1::uuid::text,$4,'FAILED','OBJECT_ACCESS_DENIED')`,[job,tenant.org,tenant.integration,message]);
 const actions:string[]=[],binding=createS3PrivateObjectStore({endpoint:'https://objects.example.test',bucket:'broker-private',region:'us-east-1',profile:'private-v1',accessKeyId:'SYNTHETICACCESS',secretAccessKey:'synthetic-only',dedicatedBucket:true});
 const objectStore:PrivateObjectStore={destinationFingerprint:binding.destinationFingerprint,
  async put(){actions.push('PUT');return {outcome:'REJECTED',code:'OBJECT_ACCESS_DENIED'};},
  async read(){actions.push('GET');throw Error('Unexpected read');},async inspect(){actions.push('INSPECT');throw Error('Unexpected inspection');},async remove(){throw Error('Unexpected cleanup');}};
 const privateStore=createDurablePrivateMediaStore({encryptionKey,profile:'private-v1',objectStore,maxStorageBytes:100,requestTimeoutMs:1000,transact:db.transact,cleanupTransact:async()=>{throw Error('No cleanup');}});
 const facade=(enabled:boolean)=>createMediaStore({encryptionKey,transact:db.transact,download:async()=>{actions.push('DOWNLOAD');return file;},...(enabled?{privateStore}:{})});
 const service=(enabled:boolean)=>createChatwootService({publicOrigin:'https://broker.example.test',encryptionKey,transact:db.transact,resolveIntegration:async()=>undefined,media:facade(enabled),fetch:async()=>{throw Error('No remote Chatwoot I/O');}});
 return {tenant,id,job,privateStore,actions,facade,service};
}
it.each([true,false])('retryJob preserves terminal private object and diagnosis with driver enabled=%s',async enabled=>{
 const h=await fixture(),staged=await h.privateStore.stage(h.tenant.org,h.id,file);
 await h.privateStore.dispatchPut(h.tenant.org,staged.objectId);
 const row=async()=>(await db.database.pool.query('SELECT * FROM messaging_media WHERE id=$1',[h.id])).rows[0];
 const object=async()=>(await db.database.pool.query('SELECT * FROM media_private_objects WHERE id=$1',[staged.objectId])).rows[0];
 const operation=async()=>(await db.database.pool.query("SELECT * FROM media_private_operations WHERE object_id=$1 AND kind='PUT'",[staged.objectId])).rows[0];
 const original=await row(),originalObject=await object(),originalOperation=await operation();
 expect(original).toMatchObject({status:'FAILED',last_error:'OBJECT_ACCESS_DENIED',storage_backend:'PRIVATE_OBJECT',private_object_id:staged.objectId});
 expect(await h.service(enabled).retryJob(h.tenant.org,h.job,'Synthetic media retry')).toEqual({ok:true});
 expect(await row()).toEqual(original);expect(await object()).toEqual(originalObject);expect(await operation()).toEqual(originalOperation);
 expect((await db.database.pool.query('SELECT status,last_error FROM integration_jobs WHERE id=$1',[h.job])).rows[0]).toEqual({status:'PENDING',last_error:null});
 await h.facade(enabled).runOnce(h.tenant.org);
 await expect(h.facade(enabled).read(h.tenant.org,h.id)).rejects.toMatchObject({code:enabled?'OBJECT_ACCESS_DENIED':'MEDIA_OBJECT_BACKEND_UNAVAILABLE',retrySafe:!enabled});
 expect(await row()).toEqual(original);expect(h.actions).toEqual(['PUT']);
});
it('retryJob still reopens an inline download before private staging',async()=>{
 const h=await fixture();await db.database.pool.query("UPDATE messaging_media SET status='FAILED',last_error='MEDIA_DOWNLOAD_FAILED',attempts=2 WHERE id=$1",[h.id]);
 await h.service(false).retryJob(h.tenant.org,h.job,'Synthetic download retry');
 expect((await db.database.pool.query('SELECT status,last_error,attempts,storage_backend,private_object_id FROM messaging_media WHERE id=$1',[h.id])).rows[0])
  .toEqual({status:'PENDING',last_error:null,attempts:0,storage_backend:'INLINE_V1',private_object_id:null});
});
