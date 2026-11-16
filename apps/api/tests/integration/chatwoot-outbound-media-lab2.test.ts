import {createHash,createHmac,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import type {BinaryMedia} from '@jrc/providers';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {chatwootEnvironment,createChatwootService,type ChatwootOptions} from '../../src/modules/integrations/chatwoot-service.js';
import {createChatwootWorker} from '../../src/modules/integrations/chatwoot-worker.js';
import {initializeChatwootAttendanceMap} from '../../src/modules/integrations/chatwoot-attendance-store.js';
import {readChatwootAccount} from '../../src/modules/integrations/chatwoot-context.js';
import {createPostgresMessagingRepository} from '../../src/modules/messaging/repository.js';
import {createMessagingWorker} from '../../src/modules/messaging/worker.js';
import {createS3PrivateObjectStore} from '../../src/modules/messaging/private-object-store.js';
import {createDurablePrivateMediaStore} from '../../src/modules/messaging/durable-private-media.js';
import {createMediaStore} from '../../src/modules/messaging/media-store.js';
import {assertPartnerMessageAuthority} from '../../src/modules/messaging/partner-authority.js';
import {assertQueuedMediaAuthority} from '../../src/modules/automations/conversation-media.js';
import {initializeHistoryLabBucket} from '../../../../labs/history-sync-lab2/storage-fixture.mjs';

type Consumer={accountId:number;inboxId:number;agentId:number;adminToken:string;agentToken:string};
const fixtures=[{file:'sample.png',mime:'image/png',kind:'image' as const},
  {file:'sample.ogg',mime:'audio/ogg',kind:'audio' as const},
  {file:'sample.pdf',mime:'application/pdf',kind:'document' as const}];
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

// Real Rails HTTP, committed webhook obligations, PostgreSQL and private MinIO.
// Only the external provider upload/send ACK is simulated; no WhatsApp session is used.
it.skipIf(process.env.HISTORY_LAB2_E2E!=='true')('delivers committed human PNG/OGG/PDF obligations once through private Broker custody and exact provider receipts in two Accounts',async()=>{
  const origin=process.env.HISTORY_LAB2_ORIGIN,endpoint=process.env.HISTORY_LAB_MINIO_ENDPOINT;
  const checkout=process.env.HISTORY_LAB2_CHECKOUT,container=process.env.HISTORY_LAB_RAILS_CONTAINER;
  if(origin!=='http://127.0.0.1:54141'||!/^http:\/\/127[.]0[.]0[.]1:\d+$/u.test(endpoint??'')
    ||container!=='jrc-history-v2-http-20261112'||!checkout)throw Error('Only dedicated synthetic laboratory permitted');
  const label=execFileSync('docker',['--context',process.env.HISTORY_LAB_DOCKER_CONTEXT??'desktop-linux','inspect','--format',
    '{{index .Config.Labels "com.jrc.test"}}',container],{encoding:'utf8',timeout:30000}).trim();
  if(label!=='jrc-history-v2-complete-20261112')throw Error('Invalid synthetic container label');
  const lab=async(path:string,input:unknown)=>{
    const response=await fetch(`${origin}/__history_lab/${path}`,{method:'POST',headers:{'Content-Type':'application/json',
      'X-History-Lab-Key':process.env.HISTORY_LAB_HTTP_KEY!},body:JSON.stringify(input),signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw Error(`SYNTHETIC_FIXTURE_${response.status}`);
    return response.json();
  };
  const db=await attendanceDatabase();
  try{
    const sources=await Promise.all([seedAttendanceTenant(db.database,false),seedAttendanceTenant(db.database,false)]);
    const consumers=await lab('seed',sources.map(t=>({organizationId:t.org,integrationId:t.integration,instanceId:randomUUID()}))) as Consumer[];
    expect(consumers).toHaveLength(2);
    await initializeHistoryLabBucket({labOnly:true,endpoint:endpoint!,accessKeyId:process.env.HISTORY_LAB_MINIO_ACCESS!,
      secretAccessKey:process.env.HISTORY_LAB_MINIO_SECRET!});
    const encryptionKey=Buffer.alloc(32,84).toString('base64');
    const objectStore=createS3PrivateObjectStore({endpoint:endpoint!,bucket:'synthetic-broker-history-20261112',profile:'synthetic-history',
      region:'us-east-1',accessKeyId:process.env.HISTORY_LAB_MINIO_ACCESS!,secretAccessKey:process.env.HISTORY_LAB_MINIO_SECRET!,
      dedicatedBucket:true,allowLoopbackHttpForTests:true,requestTimeoutMs:5000});
    const privateStore=createDurablePrivateMediaStore({transact:db.transact,cleanupTransact:async()=>{throw Error('Cleanup outside test scope');},
      encryptionKey,profile:'synthetic-history',objectStore,maxStorageBytes:64*1024*1024,requestTimeoutMs:5000});
    const sent:{organizationId:string;messageId:string;recipient:string;providerId:string;hash:string;caption:string|undefined}[]=[];
    for(const [index,t]of sources.entries()){
      const consumer=consumers[index]!,other=sources[1-index]!;
      const api=async(path:string,method='GET',body?:unknown,token=consumer.adminToken)=>{
        const response=await fetch(`${origin}/api/v1/accounts/${consumer.accountId}${path}`,{method,headers:{api_access_token:token,
          ...(body instanceof FormData?{}:{'Content-Type':'application/json'})},signal:AbortSignal.timeout(60000),
          ...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})});
        if(!response.ok)throw Error(`SYNTHETIC_OUTBOUND_API_${method}_${response.status}`);
        return response.json();
      };
      const contact=await api('/contacts','POST',{name:`Synthetic outbound media ${index}`,identifier:`synthetic-outbound-${randomUUID()}`});
      const contactId=contact.payload.contact.id as number;
      const linked=await api(`/contacts/${contactId}/contact_inboxes`,'POST',{inbox_id:consumer.inboxId});
      const remote=await api('/conversations','POST',{inbox_id:consumer.inboxId,contact_id:contactId,source_id:linked.source_id,status:'open'});
      const remoteId=remote.id as number;
      await api(`/conversations/${remoteId}/assignments`,'POST',{assignee_id:consumer.agentId});
      // Only the fixture's real signed-blob proxy is substituted for its Docker-only redirect host.
      // API responses and attachment bytes still come from Rails/ActiveStorage/MinIO.
      const proxyFetch:typeof fetch=async(input,init)=>{
        const url=new URL(String(input));
        if(url.origin!==origin)throw Error('Synthetic download escaped the Rails laboratory');
        if(url.pathname.startsWith('/rails/active_storage/blobs/redirect/'))
          url.pathname=url.pathname.replace('/blobs/redirect/','/blobs/proxy/');
        return fetch(url,init);
      };
      const options:ChatwootOptions={baseUrl:origin,publicOrigin:'https://synthetic.example.test',allowLocal:true,encryptionKey,
        transact:db.transact,resolveIntegration:async id=>id===t.integration?t.org:undefined,fetch:proxyFetch};
      const env=chatwootEnvironment(options),secret=`synthetic-${randomUUID()}`;
      await db.database.pool.query("INSERT INTO chatwoot_destinations(organization_id,base_url,mode,approval_status) VALUES($1,$2,'MANAGED','APPROVED')",[t.org,origin]);
      await db.database.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,$2,$3,$4,'READY')",
        [t.org,origin,consumer.accountId,env.vault.encrypt(`${t.org}:chatwoot-account`,consumer.adminToken)]);
      await db.database.pool.query("INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status,encrypted_webhook_secret) VALUES($1,$2,$3,$4,'Synthetic outbound media','READY',$5)",
        [t.integration,t.org,t.channel,consumer.inboxId,env.vault.encrypt(`${t.org}:chatwoot-webhook:${t.integration}`,secret)]);
      await db.database.pool.query('INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) VALUES($1,$2,$3,$4,$5,$6)',
        [t.org,t.integration,t.conversation,contactId,linked.source_id,remoteId]);
      await db.database.pool.query("INSERT INTO attendance_owners(organization_id,channel_id,integration_id,executor,revision,automation_id,version) VALUES($1,$2,$3,'BROKER',1,$4,1)",
        [t.org,t.channel,t.integration,t.automation]);
      const account=(await db.transact(t.org,tx=>readChatwootAccount(tx,t.org)))!;
      const client=env.client(account);
      const current=await client.attendanceConversation(consumer.accountId,remoteId);
      await db.transact(t.org,tx=>initializeChatwootAttendanceMap(tx,{...t.scope,accountId:consumer.accountId,inboxId:consumer.inboxId,credentialRevision:1},
        {conversationId:t.conversation,remoteConversationId:remoteId,canonical:current}));
      // Synthetic prior inbound opens the META window; it is not evidence of an HTTP ingress mirror.
      await db.database.pool.query("INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,'INCOMING','CONTACT','{\"type\":\"TEXT\",\"text\":\"Synthetic prior inbound\"}','DELIVERED')",[t.org,t.channel,t.conversation]);
      await db.database.pool.query("UPDATE integration_jobs SET status='SUCCEEDED' WHERE organization_id=$1",[t.org]);
      const media=createMediaStore({transact:db.transact,encryptionKey,privateStore,maxStorageBytes:64*1024*1024,download:async asset=>{
        expect(asset.organization_id).toBe(t.org);expect(asset.channel_id).toBe(t.channel);expect(asset.source).toBe('CHATWOOT');
        const descriptor=asset.descriptor;
        expect(descriptor.integrationId).toBe(t.integration);expect(descriptor.conversationId).toBe(remoteId);
        return client.downloadAttachment(consumer.accountId,consumer.inboxId,remoteId,Number(descriptor.messageId),Number(descriptor.attachmentId));
      }});
      options.media=media;
      const service=createChatwootService(options),mirror=createChatwootWorker(options);
      for(const [ordinal,fixture]of fixtures.entries()){
        const bytes=readFileSync(join(checkout,'spec/assets',fixture.file)),digest=sha(bytes),prefix=`Synthetic ${index}/${ordinal} `;
        const caption=prefix+'c'.repeat(1024-prefix.length);
        const form=new FormData();form.set('message_type','outgoing');form.set('private','false');form.set('content',caption);
        form.append('attachments[]',new Blob([new Uint8Array(bytes)],{type:fixture.mime}),fixture.file);
        const outgoing=await api(`/conversations/${remoteId}/messages`,'POST',form,consumer.agentToken);
        // A second HTTP request observes the durable obligation only after the creation transaction committed.
        const original=await lab('outbound-read',{protocol:'outbound-read/v1',accountId:consumer.accountId,messageId:outgoing.id});
        expect(original.message).toMatchObject({id:outgoing.id,inboxId:consumer.inboxId,conversationId:remoteId,
          contentAttributes:{jrc_broker_outbound:{version:1,state:'PENDING',intent_id:original.delivery.id,integration_id:t.integration,inbox_id:consumer.inboxId}}});
        expect(original.callback.sender).toMatchObject({id:consumer.agentId,type:'user'});
        expect(original.callback.attachments).toHaveLength(1);
        expect(new URL(String(original.callback.attachments[0].data_url)).origin).toBe(origin);
        expect(original.callback.content).toBe(caption);
        const raw=Buffer.from(JSON.stringify(original.callback)),timestamp=String(Math.floor(Date.now()/1000));
        const signature='sha256='+createHmac('sha256',secret).update(`${timestamp}.`).update(raw).digest('hex');
        await service.ingest(t.integration,raw,timestamp,signature);await service.ingest(t.integration,raw,timestamp,signature);
        await Promise.all([createChatwootWorker(options).runOnce(t.org),createChatwootWorker(options).runOnce(t.org)]);
        const mapped=(await db.database.pool.query(`SELECT m.id,m.state,m.content,m.media_id,asset.status AS media_status FROM chatwoot_messages cm
          JOIN messaging_messages m ON m.organization_id=cm.organization_id AND m.id=cm.message_id
          JOIN messaging_media asset ON asset.organization_id=m.organization_id AND asset.id=m.media_id
          WHERE cm.organization_id=$1 AND cm.integration_id=$2 AND cm.remote_message_id=$3`,[t.org,t.integration,outgoing.id])).rows;
        expect(mapped).toHaveLength(1);const canonical=mapped[0]!;
        expect(canonical).toMatchObject({state:'ACCEPTED',content:{type:'MEDIA',kind:fixture.kind,caption},media_status:'PENDING'});
        expect((await db.database.pool.query("SELECT count(*)::integer AS n FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY' AND message_id=$2",[t.org,canonical.id])).rows[0].n).toBe(1);
        const queued=await lab('outbound-read',{protocol:'outbound-read/v1',accountId:consumer.accountId,messageId:outgoing.id});
        expect(queued.message.contentAttributes.jrc_broker_outbound.state).toBe('PENDING');
        await media.runOnce(t.org);
        const custody=(await db.database.pool.query(`SELECT asset.status,asset.sha256,asset.storage_backend,obj.state AS object_state,
          obj.staging_ciphertext,op.state AS operation_state FROM messaging_media asset
          JOIN media_private_objects obj ON obj.organization_id=asset.organization_id AND obj.id=asset.private_object_id
          JOIN media_private_operations op ON op.organization_id=obj.organization_id AND op.object_id=obj.id AND op.kind='PUT'
          WHERE asset.organization_id=$1 AND asset.id=$2`,[t.org,canonical.media_id])).rows;
        expect(custody).toEqual([{status:'READY',sha256:digest,storage_backend:'PRIVATE_OBJECT',object_state:'READY',staging_ciphertext:null,operation_state:'CONFIRMED'}]);
        const stored=await media.read(t.org,canonical.media_id);
        expect(sha(stored.bytes)).toBe(digest);expect(stored.mimeType).toBe(fixture.mime);expect(stored.kind).toBe(fixture.kind);
        await expect(media.read(other.org,canonical.media_id)).rejects.toThrow('MEDIA_NOT_FOUND');
        const providerId=`synthetic-outbound-${index}-${ordinal}`,uploads:BinaryMedia[]=[];
        const worker=createMessagingWorker({repository:createPostgresMessagingRepository(),transact:db.transact,
          resolveMetaClient:async()=>({async sendText(){throw Error('Unexpected synthetic text');},async sendTemplate(){throw Error('Unexpected synthetic template');},async listTemplates(){return[];}}),
          async resolveTypebotClient(){throw Error('Unexpected external automation');},
          async prepareMedia(claim){
            expect(claim.channel.provider).toBe('META');expect(claim.message.id).toBe(canonical.id);
            if(claim.message.content.type!=='MEDIA')throw Error('Expected synthetic media claim');
            const content=claim.message.content;
            const file={...(await media.read(t.org,content.mediaId,{authorize:async tx=>{
              await assertPartnerMessageAuthority(tx as TenantTransaction,t.org,claim.message.id);await assertQueuedMediaAuthority(tx as TenantTransaction,t.org,claim.message.id);
            }})),...(content.caption?{caption:content.caption}:{})};
            // Provider upload is stubbed, with actual private bytes inspected before the final lease validation.
            uploads.push(file);expect(sha(file.bytes)).toBe(digest);expect(file.caption).toBe(caption);expect(file.mimeType).toBe(fixture.mime);
            return async()=>{sent.push({organizationId:t.org,messageId:canonical.id,recipient:claim.contact.externalId,providerId,hash:sha(file.bytes),caption:file.caption});return{upstreamMessageId:providerId};};
          }});
        await worker.runOnce(t.org);await worker.runOnce(t.org);expect(uploads).toHaveLength(1);
        expect(sent.filter(row=>row.messageId===canonical.id)).toEqual([{organizationId:t.org,messageId:canonical.id,recipient:'synthetic',providerId,hash:digest,caption}]);
        expect((await db.database.pool.query('SELECT state,upstream_message_id FROM messaging_messages WHERE organization_id=$1 AND id=$2',[t.org,canonical.id])).rows)
          .toEqual([{state:'SENT',upstream_message_id:providerId}]);
        expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1 AND message_id=$2',[t.org,canonical.id])).rows).toEqual([]);
        for(let n=0;n<4;n++)await mirror.runOnce(t.org);
        const final=await lab('outbound-read',{protocol:'outbound-read/v1',accountId:consumer.accountId,messageId:outgoing.id});
        expect(final.delivery.id).toBe(original.delivery.id);
        expect(final.message).toMatchObject({status:'sent',contentAttributes:{jrc_broker_outbound:{version:1,state:'SENT',
          intent_id:original.delivery.id,canonical_message_id:canonical.id,provider_message_id:providerId}}});
        await service.ingest(t.integration,raw,timestamp,signature);await mirror.runOnce(t.org);await worker.runOnce(t.org);
        expect(sent.filter(row=>row.messageId===canonical.id)).toHaveLength(1);
        const persisted=await client.canonicalMessage(consumer.accountId,consumer.inboxId,remoteId,outgoing.id);
        expect(persisted.attachments).toHaveLength(1);expect(persisted.content).toBe(caption);
        expect((await db.database.pool.query('SELECT count(*)::integer AS n FROM chatwoot_messages WHERE organization_id=$1 AND integration_id=$2 AND remote_message_id=$3',[t.org,t.integration,outgoing.id])).rows[0].n).toBe(1);
      }
      const visible=await api('/conversations?assignee_type=me&inbox_scope=member&status=all','GET',undefined,consumer.agentToken);
      expect(visible.data.payload.some((row:{id:number;inbox_id:number})=>row.id===remoteId&&row.inbox_id===consumer.inboxId)).toBe(true);
      const foreign=await fetch(`${origin}/api/v1/accounts/${consumers[1-index]!.accountId}/conversations`,{headers:{api_access_token:consumer.agentToken},signal:AbortSignal.timeout(60000)});
      expect([401,403]).toContain(foreign.status);
    }
    expect(sent).toHaveLength(6);
  }finally{await db.dispose();}
},420000);
