import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { initializeChatwootAttendanceMap } from '../../src/modules/integrations/chatwoot-attendance-store.js';
import { chatwootEnvironment, createChatwootService, type ChatwootOptions } from '../../src/modules/integrations/chatwoot-service.js';
import { createChatwootWorker } from '../../src/modules/integrations/chatwoot-worker.js';

describe('durable new human intent around unrelated uncertain mirrors', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => { db = await attendanceDatabase(); }, 600_000);
  afterAll(async () => { await db?.dispose(); });

  async function fixture() {
    const t = await seedAttendanceTenant(db.database);
    const next = randomUUID(), intent = randomUUID();
    const contact = (await db.database.pool.query(`INSERT INTO messaging_contacts(organization_id,external_id)
      VALUES($1,$2) RETURNING id`, [t.org, `synthetic-${next}`])).rows[0].id;
    await db.database.pool.query(`INSERT INTO messaging_conversations(id,organization_id,channel_id,contact_id)
      VALUES($1,$2,$3,$4)`, [next, t.org, t.channel, contact]);
    await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
      VALUES($1,$2,$3,41,'first-source',51),($1,$2,$4,42,'second-source',52)`, [t.org,t.integration,t.conversation,next]);
    await db.database.pool.query(`INSERT INTO attendance_owners(organization_id,channel_id,integration_id,executor,revision,automation_id,version)
      VALUES($1,$2,$3,'BROKER',1,$4,1)`, [t.org,t.channel,t.integration,t.automation]);
    const scope={...t.scope,credentialRevision:1};
    await db.transact(t.org, tx => initializeChatwootAttendanceMap(tx,scope,{conversationId:next,remoteConversationId:52,
      canonical:{id:52,account_id:7,inbox_id:9,status:'open',updated_at:100,meta:{assignee:{id:12,type:'user'},assignee_type:'User',team:null}}}));
    const incoming = (await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
      VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"Synthetic pending mirror"}','DELIVERED') RETURNING id`,[t.org,t.channel,t.conversation])).rows[0].id;
    const unknown = (await db.database.pool.query(`UPDATE integration_jobs SET status='UNKNOWN',attempts=1,
      payload='{"operation":"SEND_MESSAGE","conversationId":51}',last_error='CHATWOOT_OUTCOME_UNKNOWN'
      WHERE organization_id=$1 AND message_id=$2 RETURNING id`,[t.org,incoming])).rows[0].id;
    const marker={version:1,state:'PENDING',intent_id:intent,integration_id:t.integration,inbox_id:9};
    const message={event:'message_created',id:701,account:{id:7},inbox:{id:9},conversation:{id:52,inbox_id:9},
      message_type:'outgoing',private:false,sender:{id:12,type:'user'},content:'New independently authorized human reply',
      content_attributes:{jrc_broker_outbound:marker}};
    let canonical:Record<string,unknown>={id:701,account_id:7,inbox_id:9,conversation_id:52,message_type:1,private:false,
      sender:{id:12,type:'user'},content:message.content,content_attributes:message.content_attributes,attachments:[],created_at:1_700_000_000};
    const calls:string[]=[];
    const options:ChatwootOptions={baseUrl:`https://${t.org}.example.test`,publicOrigin:'https://broker.example.test',
      encryptionKey:Buffer.alloc(32,6).toString('base64'),transact:db.transact,resolveIntegration:async id=>id===t.integration?t.org:undefined,
      async fetch(input,init){const path=new URL(String(input)).pathname;calls.push(`${init?.method??'GET'} ${path}`);
        if(path==='/api/v1/accounts/7/conversations/52/messages'&&(!init?.method||init.method==='GET'))return Response.json({payload:[canonical]});
        throw new Error(`Unexpected synthetic request ${init?.method??'GET'} ${path}`);}};
    const vault=chatwootEnvironment(options).vault,secret='synthetic-human-intent-secret';
    await db.database.pool.query('UPDATE chatwoot_accounts SET encrypted_token=$2 WHERE organization_id=$1',[t.org,vault.encrypt(`${t.org}:chatwoot-account`,'synthetic-token')]);
    await db.database.pool.query('UPDATE chatwoot_connections SET encrypted_webhook_secret=$2 WHERE id=$1',[t.integration,vault.encrypt(`${t.org}:chatwoot-webhook:${t.integration}`,secret)]);
    const service=createChatwootService(options);
    const ingest=async(raw:unknown)=>{const bytes=Buffer.from(JSON.stringify(raw)),timestamp=String(Math.floor(Date.now()/1000));
      return service.ingest(t.integration,bytes,timestamp,'sha256='+createHmac('sha256',secret).update(timestamp+'.').update(bytes).digest('hex'));};
    return {...t,next,intent,unknown,marker,message,options,calls,ingest,setCanonical:(value:Record<string,unknown>)=>{canonical={...canonical,...value};}};
  }

  it('enqueues one new proven human reply without retrying or clearing an unrelated UNKNOWN',async()=>{
    const t=await fixture();
    await t.ingest(t.message);
    await createChatwootWorker(t.options).runOnce(t.org);
    const outbox=(await db.database.pool.query(`SELECT m.conversation_id,m.content,m.source FROM messaging_outbox o
      JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id WHERE o.organization_id=$1`,[t.org])).rows;
    expect(outbox).toEqual([{conversation_id:t.next,content:{type:'TEXT',text:t.message.content},source:'OPERATOR'}]);
    expect((await db.database.pool.query('SELECT status,attempts,last_error FROM integration_jobs WHERE id=$1',[t.unknown])).rows[0])
      .toEqual({status:'UNKNOWN',attempts:1,last_error:'CHATWOOT_OUTCOME_UNKNOWN'});
    expect(t.calls).toEqual(['GET /api/v1/accounts/7/conversations/52/messages']);
    expect((await db.database.pool.query("SELECT status FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows)
      .toEqual([{status:'SUCCEEDED'}]);
  });

  it('keeps an old human callback without durable intent fenced',async()=>{
    const t=await fixture();await t.ingest({...t.message,content_attributes:{}});
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query("SELECT status,attempts FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows)
      .toEqual([{status:'PENDING',attempts:0}]);
    expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('deduplicates signed callback redelivery and concurrent workers',async()=>{
    const t=await fixture();await t.ingest(t.message);await t.ingest(t.message);
    await Promise.all([createChatwootWorker(t.options).runOnce(t.org),createChatwootWorker(t.options).runOnce(t.org)]);
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0].n).toBe(1);
    expect((await db.database.pool.query("SELECT count(*)::int AS n FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows[0].n).toBe(1);
  });

  it.each(['intent','content','sender','private','historical'] as const)('refuses canonical %s drift before creating an outbox message',async drift=>{
    const t=await fixture();await t.ingest(t.message);
    if(drift==='intent')t.setCanonical({content_attributes:{jrc_broker_outbound:{...t.marker,intent_id:randomUUID()}}});
    if(drift==='content')t.setCanonical({content:'Modified after the authenticated callback'});
    if(drift==='sender')t.setCanonical({sender:{id:99,type:'user'}});
    if(drift==='private')t.setCanonical({private:true});
    if(drift==='historical')t.setCanonical({content_attributes:{jrc_broker_outbound:t.marker,jrc_broker_historical:true}});
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows).toEqual([]);
    expect((await db.database.pool.query("SELECT status,last_error FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows[0])
      .toEqual({status:'FAILED',last_error:'CHATWOOT_HUMAN_INTENT_NOT_PROVEN'});
  });

  it.each(['CREATE_CONTACT','LINK_CONTACT','CREATE_CONVERSATION','foreign-target','missing-message','reply-kind','second-same-contact'] as const)
    ('retains every uncertain barrier when %s cannot be positively isolated',async change=>{
      const t=await fixture();await t.ingest(t.message);
      if(['CREATE_CONTACT','LINK_CONTACT','CREATE_CONVERSATION'].includes(change))
        await db.database.pool.query("UPDATE integration_jobs SET payload=payload||jsonb_build_object('operation',$2::text) WHERE id=$1",[t.unknown,change]);
      if(change==='foreign-target')await db.database.pool.query("UPDATE integration_jobs SET payload=payload||'{\"conversationId\":999}' WHERE id=$1",[t.unknown]);
      if(change==='missing-message')await db.database.pool.query('UPDATE integration_jobs SET message_id=NULL WHERE id=$1',[t.unknown]);
      if(change==='reply-kind')await db.database.pool.query("UPDATE integration_jobs SET kind='CHATWOOT_REPLY' WHERE id=$1",[t.unknown]);
      if(change==='second-same-contact'){
        const same=(await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
          VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"Second uncertain contact"}','DELIVERED') RETURNING id`,[t.org,t.channel,t.next])).rows[0].id;
        await db.database.pool.query(`UPDATE integration_jobs SET status='UNKNOWN',attempts=1,payload='{"operation":"SEND_MESSAGE","conversationId":52}'
          WHERE organization_id=$1 AND message_id=$2`,[t.org,same]);
      }
      await createChatwootWorker(t.options).runOnce(t.org);
      expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows).toEqual([]);
      expect((await db.database.pool.query("SELECT status,attempts FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY' AND payload->>'messageId'='701'",[t.org])).rows)
        .toEqual([{status:'PENDING',attempts:0}]);
      expect(t.calls).toEqual([]);
    });

  it('does not enqueue after the current credential revision changes during the canonical read',async()=>{
    const t=await fixture();await t.ingest(t.message);
    const options={...t.options,async fetch(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1]){
      const result=await t.options.fetch!(input,init);
      await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1',[t.org]);
      return result;
    }};
    await createChatwootWorker(options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows).toEqual([]);
    expect((await db.database.pool.query("SELECT status,last_error FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows[0])
      .toEqual({status:'FAILED',last_error:'CHATWOOT_CONTEXT_CHANGED'});
  });

  it('retries a failed canonical GET without re-posting a reply or clearing UNKNOWN',async()=>{
    const t=await fixture();await t.ingest(t.message);
    const unavailable={...t.options,async fetch(){return new Response('',{status:503});}};
    await createChatwootWorker(unavailable).runOnce(t.org);
    expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows).toEqual([]);
    expect((await db.database.pool.query("SELECT status,last_error FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows[0])
      .toEqual({status:'PENDING',last_error:'CHATWOOT_REQUEST_REJECTED'});
    await db.database.pool.query("UPDATE integration_jobs SET available_at=now()-interval '1 second' WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org]);
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0].n).toBe(1);
    expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1',[t.unknown])).rows[0]).toEqual({status:'UNKNOWN',attempts:1});
  });

  it.each([['image','image'],['audio','audio'],['file','document']] as const)('preserves a new %s intent and its caption once across callback retries',async(fileType,kind)=>{
    const t=await fixture(),raw={...t.message,content:'Synthetic attachment caption',attachments:[{id:801,file_type:fileType}]};
    t.setCanonical({content:raw.content,attachments:raw.attachments});
    await t.ingest(raw);await t.ingest(raw);await createChatwootWorker(t.options).runOnce(t.org);
    const rows=(await db.database.pool.query(`SELECT m.content,media.kind,media.source,media.status FROM messaging_outbox o
      JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id
      JOIN messaging_media media ON media.organization_id=m.organization_id AND media.id=m.media_id WHERE o.organization_id=$1`,[t.org])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({content:{type:'MEDIA',kind,caption:'Synthetic attachment caption'},kind,source:'CHATWOOT',status:'PENDING'});
    expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1',[t.unknown])).rows[0]).toEqual({status:'UNKNOWN',attempts:1});
  });

  it('holds current credential scope through COMMIT when rotation starts after the final account read',async()=>{
    const t=await fixture();await t.ingest(t.message);
    let armed=false,paused=false,entered!:()=>void,release!:()=>void;
    const reached=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
    const options:ChatwootOptions={...t.options,async fetch(input,init){const response=await t.options.fetch!(input,init);armed=true;return response;},
      transact:((org,work)=>db.transact(org,async transaction=>{
        const wrapped=new Proxy(transaction,{get(target,key){
          if(key!=='query')return Reflect.get(target,key);
          return async(text:string,values?:unknown[])=>{const result=await target.query(text,values);
            if(armed&&!paused&&text.startsWith('SELECT organization_id,base_url,account_id')){paused=true;entered();await resume;}
            return result;};
        }});
        return work(wrapped);
      })) as ChatwootOptions['transact']};
    const worker=createChatwootWorker(options).runOnce(t.org),rotator=await db.database.pool.connect();
    let rotating:Promise<unknown>|undefined,rotationState='NOT_STARTED';
    try{
      await reached;
      const pid=(await rotator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      rotationState='RUNNING';
      rotating=rotator.query('UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1',[t.org])
        .then(result=>{rotationState='COMMITTED';return result;});
      await vi.waitFor(async()=>{
        if(rotationState==='COMMITTED')return;
        const state=(await db.database.pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
        expect(state?.wait_event_type).toBe('Lock');
      },{timeout:10000,interval:20});
      expect(rotationState).toBe('RUNNING');
    }finally{release();await worker;await rotating;rotator.release();}
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0].n).toBe(1);
  });
});
