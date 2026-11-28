import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {connectionStringForRole} from './helpers/task7.js';
import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl} from './helpers/postgres.js';
import {verifyDirectStores} from '../../src/modules/integrations/direct-receipt-stores.js';

describe('direct receipt verified against read-only historical stores',()=>{
  const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
  let db:Awaited<ReturnType<typeof createIsolatedPostgresDatabase>>,rails:Pool,evo:Pool;
  const org=randomUUID(),integration=randomUUID(),channel=randomUUID(),job=randomUUID(),obligation=randomUUID();
  const original={accountId:1,inboxId:32,conversationId:53,messageId:701};
  const key='synthetic-provider-key',peer='15550001111@s.whatsapp.net',instance='previous-real-id';
  const custody=Buffer.from(JSON.stringify({organizationId:org,integrationId:integration,channelId:channel,origin:'https://example.test',
    accountId:1,inboxId:32,instanceId:instance,generation:'g1',brokerInstanceId:'broker-previous-id',
    validFrom:'2023-01-01T00:00:00Z',validUntil:'2024-01-01T00:00:00Z'}));
  const p={protocol:'DIRECT_EVOLUTION_RECEIPT_V1',organizationId:org,integrationId:integration,channelId:channel,jobId:job,origin:'https://example.test',credentialRevision:1,destinationRevision:1,
    rails:{...original,obligationId:obligation,intentId:null,sourceId:'WAID:'+key,bodySha256:hash('hello'),attachmentCount:0,humanPublic:true},
    historicalBinding:{instanceId:instance,generation:'g1',evidenceSha256:hash(custody)},
    evolution:{...original,instanceId:instance,rowId:'message-row',key,peer,fromMe:true,bodySha256:hash('hello'),partCount:1,matchingRows:1},
    ack:{instanceId:instance,messageRowId:'message-row',rowId:'update-row',key,peer,fromMe:true,status:'READ'}};
  beforeAll(async()=>{
    db=await createIsolatedPostgresDatabase(requireTestDatabaseAdminUrl());rails=new Pool({connectionString:db.connectionString});evo=new Pool({connectionString:db.connectionString});
    await db.pool.query(`CREATE TABLE messages(id int,account_id int,inbox_id int,conversation_id int,private boolean,message_type int,sender_id int,sender_type text,content text,source_id text,content_attributes jsonb,additional_attributes jsonb);
      CREATE TABLE conversations(id int,account_id int,inbox_id int,display_id int,contact_id int,contact_inbox_id int);
      CREATE TABLE contacts(id int,account_id int,phone_number text);CREATE TABLE contact_inboxes(id int,contact_id int,inbox_id int);CREATE TABLE attachments(message_id int);
      CREATE TABLE jrc_broker_webhook_obligations(delivery_id uuid,account_id int,inbox_id int,message_id int,integration_id text,instance_id text,created_at timestamptz);
      CREATE TABLE "Message"(id text,"instanceId" text,"chatwootMessageId" int,"chatwootInboxId" int,"chatwootConversationId" int,key jsonb,message jsonb,"messageTimestamp" int);
      CREATE TABLE "MessageUpdate"(id text,"instanceId" text,"messageId" text,"keyId" text,"remoteJid" text,"fromMe" boolean,status text);
      CREATE TABLE "Chatwoot"("instanceId" text,"accountId" text,url text);
      INSERT INTO conversations VALUES(100,1,32,53,101,102);INSERT INTO contacts VALUES(101,1,'+15550001111');INSERT INTO contact_inboxes VALUES(102,101,32);`);
    await db.pool.query("INSERT INTO messages VALUES(701,1,32,100,false,1,7,'User','hello',$1,'{}','{}')",['WAID:'+key]);
    await db.pool.query("INSERT INTO jrc_broker_webhook_obligations VALUES($1,1,32,701,$2,'broker-previous-id','2023-11-14')",[obligation,integration]);
    await db.pool.query("INSERT INTO \"Chatwoot\" VALUES($1,'1','https://example.test')",[instance]);
    await db.pool.query('INSERT INTO "Message" VALUES($1,$2,701,32,53,$3,$4,1700000000)',['message-row',instance,{id:key,fromMe:true,remoteJid:peer},{conversation:'hello'}]);
    await db.pool.query('INSERT INTO "MessageUpdate" VALUES($1,$2,$3,$4,$5,true,$6)',['update-row',instance,'message-row',key,peer,'READ']);
  });
  afterAll(async()=>{await rails?.end();await evo?.end();await db?.dispose();});
  it('verifies the exact rows on both stores without a signing credential',async()=>{
    await expect(verifyDirectStores(Buffer.from(JSON.stringify(p)),custody,hash(custody),rails,evo)).resolves.toBeDefined();
  });
  it.each(['wrong-key','wrong-peer','wrong-binding','changed-body','wrong-generation','wrong-update','wrong-obligation'])('rejects %s even though the other source matches',async which=>{
    const v=structuredClone(p);
    if(which==='wrong-key')v.evolution.key+='x';
    if(which==='wrong-peer')v.ack.peer='15550002222@s.whatsapp.net';
    if(which==='wrong-generation')v.historicalBinding.generation='g2';
    if(which==='changed-body')v.rails.bodySha256=hash('changed');
    if(which==='wrong-update')v.ack.rowId='other-update';
    if(which==='wrong-obligation')v.rails.obligationId=randomUUID();
    await expect(verifyDirectStores(Buffer.from(JSON.stringify(v)),custody,which==='wrong-binding'?hash('other'):hash(custody),rails,evo)).rejects.toThrow();
  });
  it('rejects a changed Rails conversation recipient despite matching Evolution IDs and ACK',async()=>{
    await db.pool.query("UPDATE contacts SET phone_number='+15550002222' WHERE id=101");
    try{await expect(verifyDirectStores(Buffer.from(JSON.stringify(p)),custody,hash(custody),rails,evo)).rejects.toThrow();}
    finally{await db.pool.query("UPDATE contacts SET phone_number='+15550001111' WHERE id=101");}
  });
  it('runs the compiled CLI through preview, commit and replay against independent stores',async()=>{
    const broker=await attendanceDatabase(),dir=await mkdtemp(join(tmpdir(),'jrc-direct-receipt-'));
    try{
      const t=await seedAttendanceTenant(broker.database),v=structuredClone(p);
      const origin='https://'+t.org+'.example.test';
      Object.assign(v,{organizationId:t.org,integrationId:t.integration,channelId:t.channel,origin});
      Object.assign(v.rails,{accountId:7,inboxId:9});Object.assign(v.evolution,{accountId:7,inboxId:9});
      const binding=Buffer.from(JSON.stringify({...JSON.parse(custody.toString()),organizationId:t.org,integrationId:t.integration,
        channelId:t.channel,origin,accountId:7,inboxId:9}));
      v.historicalBinding.evidenceSha256=hash(binding);
      await db.pool.query("UPDATE messages SET account_id=7,inbox_id=9; UPDATE conversations SET account_id=7,inbox_id=9;UPDATE contacts SET account_id=7; UPDATE contact_inboxes SET inbox_id=9");
      await db.pool.query('UPDATE jrc_broker_webhook_obligations SET account_id=7,inbox_id=9,integration_id=$1',[t.integration]);
      await db.pool.query('UPDATE "Message" SET "chatwootInboxId"=9');
      await db.pool.query('UPDATE "Chatwoot" SET url=$1,"accountId"=$2',[origin,'7']);
      await broker.database.pool.query('UPDATE messaging_contacts SET external_id=$2 WHERE id=(SELECT contact_id FROM messaging_conversations WHERE id=$1)',[t.conversation,peer.split('@')[0]]);
      await broker.database.pool.query("INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) VALUES($1,$2,$3,7,'synthetic',53)",[t.org,t.integration,t.conversation]);
      await broker.database.pool.query("INSERT INTO integration_jobs(organization_id,integration_id,id,kind,dedupe_key,payload) VALUES($1,$2,$3,'CHATWOOT_REPLY','reply:1:7:9:701',$4)",[t.org,t.integration,job,{conversationId:53,messageId:701,destinationRevision:1,content:{type:'TEXT',text:'hello'}}]);
      const proofFile=join(dir,'original.json'),custodyFile=join(dir,'binding.json');
      await writeFile(proofFile,JSON.stringify(v));await writeFile(custodyFile,binding);
      const env={...process.env,DATABASE_URL:connectionStringForRole(broker.database.connectionString,'jrc_app'),CHATWOOT_DIRECT_RAILS_READ_URL:db.connectionString,
        CHATWOOT_DIRECT_EVOLUTION_READ_URL:db.connectionString,CHATWOOT_DIRECT_CUSTODY_FILE:custodyFile,CHATWOOT_DIRECT_CUSTODY_SHA256:hash(binding),
        CHATWOOT_DIRECT_TRANSPORT_REVIEW_INTEGRATIONS:t.integration};
      const run=async(...extra:string[])=>JSON.parse((await promisify(execFile)(process.execPath,['apps/api/dist/commands/reconcile-direct-reply.js',
        '--org',t.org,'--job',job,'--proof',proofFile,...extra],{env})).stdout);
      expect(await run()).toEqual({preview:'APPLIED'});
      expect((await broker.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1',[job])).rows[0].status).toBe('PENDING');
      expect(await run('--apply',job,'--receipt')).toMatchObject({result:'APPLIED',receipt:{state:'READ',jobId:job,obligationId:obligation}});
      expect(await run('--apply',job)).toEqual({result:'UNCHANGED'});
      expect((await broker.database.pool.query('SELECT count(*)::int n FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0].n).toBe(0);
    }finally{await broker.dispose();await rm(dir,{recursive:true,force:true});}
  },600000);});
