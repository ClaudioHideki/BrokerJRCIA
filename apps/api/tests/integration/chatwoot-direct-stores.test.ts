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
  const key='synthetic-provider-key',peer='15550001111@s.whatsapp.net',lid='12345678901234@lid',instance='previous-real-id';
  const custody=Buffer.from(JSON.stringify({organizationId:org,integrationId:integration,channelId:channel,origin:'https://example.test',
    accountId:1,inboxId:32,instanceId:instance,generation:'g1',brokerInstanceId:'broker-previous-id',
    validFrom:'2023-01-01T00:00:00Z',validUntil:'2024-01-01T00:00:00Z'}));
  const p={protocol:'DIRECT_EVOLUTION_RECEIPT_V1',organizationId:org,integrationId:integration,channelId:channel,jobId:job,origin:'https://example.test',credentialRevision:1,destinationRevision:1,
    rails:{...original,obligationId:obligation,intentId:null,sourceId:'WAID:'+key,bodySha256:hash('hello'),attachmentCount:0,humanPublic:true},
    historicalBinding:{instanceId:instance,generation:'g1',evidenceSha256:hash(custody)},
    evolution:{...original,instanceId:instance,rowId:'message-row',key,peer,remoteJid:lid,fromMe:true,bodySha256:hash('hello'),partCount:1,matchingRows:1},
    ack:{instanceId:instance,messageRowId:'message-row',rowId:'update-row',key,peer,remoteJid:lid,fromMe:true,status:'READ'}};
  beforeAll(async()=>{
    db=await createIsolatedPostgresDatabase(requireTestDatabaseAdminUrl());rails=new Pool({connectionString:db.connectionString});evo=new Pool({connectionString:db.connectionString});
    await db.pool.query(`CREATE TABLE messages(id int,account_id int,inbox_id int,conversation_id int,private boolean,message_type int,sender_id int,sender_type text,content text,source_id text,content_attributes json,additional_attributes jsonb);
      CREATE TABLE conversations(id int,account_id int,inbox_id int,display_id int,contact_id int,contact_inbox_id int);
      CREATE TABLE contacts(id int,account_id int,phone_number text);CREATE TABLE contact_inboxes(id int,contact_id int,inbox_id int);CREATE TABLE attachments(message_id int);
      CREATE TABLE jrc_broker_webhook_obligations(delivery_id uuid,account_id int,inbox_id int,message_id int,integration_id text,instance_id text,created_at timestamptz,state text,binding_id int,url text);
      CREATE TABLE jrc_broker_inbox_bindings(id int,account_id int,inbox_id int,integration_id text,instance_id text);
      CREATE TABLE inboxes(id int,account_id int,channel_type text,channel_id int); CREATE TABLE channel_api(id int,webhook_url text);
      CREATE TABLE "Message"(id text,"instanceId" text,"chatwootMessageId" int,"chatwootInboxId" int,"chatwootConversationId" int,key jsonb,message jsonb,"messageTimestamp" int);
      CREATE TABLE "MessageUpdate"(id text,"instanceId" text,"messageId" text,"keyId" text,"remoteJid" text,"fromMe" boolean,status text);
      CREATE TABLE "Chatwoot"("instanceId" text,"accountId" text,url text);
      INSERT INTO conversations VALUES(100,1,32,53,101,102);INSERT INTO contacts VALUES(101,1,'+15550001111');INSERT INTO contact_inboxes VALUES(102,101,32);`);
    await db.pool.query("INSERT INTO messages VALUES(701,1,32,100,false,1,7,'User','hello',$1,'{}','{}')",['WAID:'+key]);
    await db.pool.query("UPDATE messages SET content_attributes=to_json('{}'::text),additional_attributes=to_jsonb('{}'::text)");
    await db.pool.query("INSERT INTO jrc_broker_webhook_obligations VALUES($1,1,32,701,$2,'broker-previous-id','2023-11-14','delivered',91,'https://broker.test/callback')",[obligation,integration]);
    await db.pool.query("INSERT INTO \"Chatwoot\" VALUES($1,'1','https://example.test')",[instance]);
    await db.pool.query("INSERT INTO jrc_broker_inbox_bindings VALUES(91,1,32,$1,'broker-previous-id')",[integration]);
    await db.pool.query("INSERT INTO inboxes VALUES(32,1,'Channel::Api',413); INSERT INTO channel_api VALUES(413,'https://broker.test/callback')");
    await db.pool.query('INSERT INTO "Message" VALUES($1,$2,701,32,53,$3,$4,1700000000)',['message-row',instance,{id:key,fromMe:true,remoteJid:lid,remoteJidAlt:peer},{conversation:'hello'}]);
    await db.pool.query('INSERT INTO "MessageUpdate" VALUES($1,$2,$3,$4,$5,true,$6)',['update-row',instance,'message-row',key,lid,'READ']);
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
  it.each(['other-phone','other-lid','reversed','update-peer','missing-alt','wrong-obligation-state','rotated-binding','rotated-url','deleted','bad-json','non-object','campaign'] as const)('rejects real-store ambiguity (%s)',async scenario=>{
    if(['other-phone','other-lid','reversed'].includes(scenario)){
      const pair=scenario==='other-phone'?[lid,'15559999999@s.whatsapp.net']:scenario==='other-lid'?['999999@lid',peer]:[peer,'999999@lid'];
      await db.pool.query('INSERT INTO "Message" VALUES($1,$2,801,32,53,$3,$4,1700000001)',['other',instance,{id:'other-key',remoteJid:pair[0],remoteJidAlt:pair[1]},{}]);
    }
    if(scenario==='missing-alt')await db.pool.query("UPDATE \"Message\" SET key=key-'remoteJidAlt' WHERE id='message-row'");
    if(scenario==='update-peer')await db.pool.query('UPDATE "MessageUpdate" SET "remoteJid"=$1',[peer]);
    if(scenario==='wrong-obligation-state')await db.pool.query("UPDATE jrc_broker_webhook_obligations SET state='pending'");
    if(scenario==='rotated-binding')await db.pool.query("UPDATE jrc_broker_inbox_bindings SET instance_id='other'");
    if(scenario==='rotated-url')await db.pool.query("UPDATE channel_api SET webhook_url='https://other.test/callback'");
    if(['deleted','bad-json','non-object','campaign'].includes(scenario)){
      const value=scenario==='deleted'?'{"deleted":true}':scenario==='bad-json'?'{':scenario==='campaign'?'{"campaign_id":99}':'[]';
      await db.pool.query('UPDATE messages SET '+(scenario==='campaign'?'additional_attributes=to_jsonb($1::text)':'content_attributes=to_json($1::text)'),[value]);
    }
    try{await expect(verifyDirectStores(Buffer.from(JSON.stringify(p)),custody,hash(custody),rails,evo)).rejects.toThrow();}
    finally{
      await db.pool.query('DELETE FROM "Message" WHERE id=$1',['other']);
      await db.pool.query('UPDATE "Message" SET key=$1 WHERE id=$2',[{id:key,fromMe:true,remoteJid:lid,remoteJidAlt:peer},'message-row']);
      await db.pool.query('UPDATE "MessageUpdate" SET "remoteJid"=$1',[lid]);
      await db.pool.query("UPDATE jrc_broker_webhook_obligations SET state='delivered';UPDATE jrc_broker_inbox_bindings SET instance_id='broker-previous-id';UPDATE channel_api SET webhook_url='https://broker.test/callback';UPDATE messages SET content_attributes=to_json('{}'::text),additional_attributes=to_jsonb('{}'::text)");
    }
  });
  it('retains a direct PN proof, and excludes alias conflicts from other instances or epochs',async()=>{
    await db.pool.query('INSERT INTO "Message" VALUES($1,$2,801,32,53,$3,$4,1700000000),($5,$6,802,32,53,$3,$4,1800000000)',
      ['other-instance','unrelated',{id:'other-key',remoteJid:lid,remoteJidAlt:'15559999999@s.whatsapp.net'},{},'outside-epoch',instance]);
    try{
      await expect(verifyDirectStores(Buffer.from(JSON.stringify(p)),custody,hash(custody),rails,evo)).resolves.toBe(true);
      const pn=structuredClone(p);Reflect.deleteProperty(pn.ack,'remoteJid');Reflect.deleteProperty(pn.evolution,'remoteJid');
      await db.pool.query('UPDATE "Message" SET key=$1 WHERE id=$2',[{id:key,fromMe:true,remoteJid:peer},'message-row']);
      await db.pool.query('UPDATE "MessageUpdate" SET "remoteJid"=$1',[peer]);
      await expect(verifyDirectStores(Buffer.from(JSON.stringify(pn)),custody,hash(custody),rails,evo)).resolves.toBe(true);
    }finally{
      await db.pool.query('DELETE FROM "Message" WHERE id IN ($1,$2)',['other-instance','outside-epoch']);
      await db.pool.query('UPDATE "Message" SET key=$1 WHERE id=$2',[{id:key,fromMe:true,remoteJid:lid,remoteJidAlt:peer},'message-row']);
      await db.pool.query('UPDATE "MessageUpdate" SET "remoteJid"=$1',[lid]);
    }
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
      await db.pool.query('UPDATE jrc_broker_inbox_bindings SET account_id=7,inbox_id=9,integration_id=$1',[t.integration]);
      await db.pool.query('UPDATE inboxes SET id=9,account_id=7');
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
