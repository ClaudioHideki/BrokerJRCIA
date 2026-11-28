import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { initializeChatwootAttendanceMap } from '../../src/modules/integrations/chatwoot-attendance-store.js';
import { chatwootEnvironment, createChatwootService, type ChatwootOptions } from '../../src/modules/integrations/chatwoot-service.js';
import { registerPendingMedia } from '../../src/modules/messaging/media-store.js';
import { createChatwootWorker } from '../../src/modules/integrations/chatwoot-worker.js';

describe('durable new human intent around unrelated uncertain mirrors', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => { db = await attendanceDatabase(); }, 600_000);
  afterAll(async () => { await db?.dispose(); });

  async function fixture(sameConversation = false,policy?:'guard'|'review'|'other') {
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
      VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"Synthetic pending mirror"}','DELIVERED') RETURNING id`,[t.org,t.channel,sameConversation?next:t.conversation])).rows[0].id;
    const unknown = (await db.database.pool.query(`UPDATE integration_jobs SET status='UNKNOWN',attempts=1,
      payload='{"operation":"SEND_MESSAGE","conversationId":51}',last_error='CHATWOOT_OUTCOME_UNKNOWN'
      WHERE organization_id=$1 AND message_id=$2 RETURNING id`,[t.org,incoming])).rows[0].id;
    if(sameConversation){
      await db.database.pool.query(`UPDATE integration_jobs SET payload=jsonb_set(payload,'{conversationId}','52') WHERE id=$1`,[unknown]);
      await db.database.pool.query(`INSERT INTO chatwoot_mirror_attempts(organization_id,channel_id,integration_id,destination_revision,
        account_id,inbox_id,conversation_id,remote_conversation_id,cycle,message_id,job_id,lease_token,state)
        VALUES($1,$2,$3,1,7,9,$4,52,1,$5,$6,$7,'UNKNOWN')`,[t.org,t.channel,t.integration,next,incoming,unknown,randomUUID()]);
    }
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
    if(policy==='guard'||policy==='other')options.directSourceGuardIntegrations=new Set([policy==='guard'?t.integration:randomUUID()]);
    if(policy==='review')options.directTransportReviewIntegrations=new Set([t.integration]);
    const service=createChatwootService(options);
    const ingest=async(raw:unknown)=>{const bytes=Buffer.from(JSON.stringify(raw)),timestamp=String(Math.floor(Date.now()/1000));
      return service.ingest(t.integration,bytes,timestamp,'sha256='+createHmac('sha256',secret).update(timestamp+'.').update(bytes).digest('hex'));};
    return {...t,next,intent,unknown,marker,message,options,calls,ingest,setCanonical:(value:Record<string,unknown>)=>{canonical={...canonical,...value};}};
  }

  it('fences a persisted direct WAID before native egress under concurrent workers',async()=>{
    const t=await fixture(false,'guard');
    t.setCanonical({source_id:'WAID:synthetic-direct-key'});
    await t.ingest(t.message);
    await Promise.all([createChatwootWorker(t.options).runOnce(t.org),createChatwootWorker(t.options).runOnce(t.org)]);
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0].n).toBe(0);
    expect((await db.database.pool.query("SELECT status,last_error FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows)
      .toEqual([{status:'FAILED',last_error:'CHATWOOT_DIRECT_SOURCE_REVIEW'}]);
  });
  it('leaves both legacy and native jobs unclaimed in an integration under direct-transport review',async()=>{
    const t=await fixture();
    await t.ingest(t.message);
    await db.database.pool.query("UPDATE integration_jobs SET status='SUCCEEDED' WHERE id=$1",[t.unknown]);
    await db.database.pool.query("INSERT INTO integration_jobs(organization_id,integration_id,kind,status,payload,dedupe_key) VALUES($1,$2,'CHATWOOT_REPLY','PENDING',$3,'synthetic-held')",[t.org,t.integration,{conversationId:52,messageId:702,content:{type:'TEXT',text:'synthetic legacy'}}]);
    const options={...t.options,directTransportReviewIntegrations:new Set([t.integration])};
    await Promise.all([createChatwootWorker(options).runOnce(t.org),createChatwootWorker(options).runOnce(t.org)]);
    const jobs=await db.database.pool.query("SELECT status,attempts FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org]);
    expect(jobs.rows).toEqual([{status:'PENDING',attempts:0},{status:'PENDING',attempts:0}]);
    expect(t.calls).toEqual([]);
  });
  it('refuses a later claim after credential rotation or replay of a disarmed original',async()=>{
    const t=await fixture();await t.ingest(t.message);
    await db.database.pool.query("UPDATE integration_jobs SET status='SUCCEEDED' WHERE id=$1",[t.unknown]);
    await db.database.pool.query("UPDATE integration_jobs SET dedupe_key='reply:2:7:9:701' WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org]);
    await db.database.pool.query("UPDATE chatwoot_destinations SET revision=2 WHERE organization_id=$1",[t.org]);
    await db.database.pool.query("INSERT INTO integration_jobs(organization_id,integration_id,kind,status,dedupe_key,payload) VALUES($1,$2,'CHATWOOT_REPLY','SUCCEEDED','reply:1:7:9:701',$3)",[t.org,t.integration,{messageId:701,directEvolutionReceipt:{origin:t.options.baseUrl,protocol:'DIRECT_EVOLUTION_RECEIPT_V1'}}]);
    await createChatwootWorker(t.options).runOnce(t.org);
    const j=(await db.database.pool.query("SELECT last_error FROM integration_jobs WHERE organization_id=$1 AND dedupe_key='reply:2:7:9:701'",[t.org])).rows[0];
    expect(j.last_error).toBe('CHATWOOT_DIRECT_SOURCE_REVIEW');
    expect(t.calls).toEqual([]);
  });

  it.each(['guard','review','other',undefined] as const)('scopes the same direct webhook to the configured integration (%s)',async policy=>{
    const t=await fixture(false,policy);
    await t.ingest({...t.message,source_id:'WAID:synthetic-direct-key'});
    const rows=await db.database.pool.query("SELECT id FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org]);
    expect(rows.rowCount).toBe(policy==='guard'||policy==='review'?0:1);
  });
  it.each(['other',undefined] as const)('preserves native egress for the same WAID in a tenant outside the lists (%s)',async policy=>{
    const t=await fixture(false,policy);
    t.setCanonical({source_id:'WAID:synthetic-direct-key'});
    await t.ingest(t.message);await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(1);
  });
  it('checks a native WAID even when Rails returns serialized legacy JSON attributes',async()=>{
    const t=await fixture(false,'guard');
    t.setCanonical({source_id:'WAID:synthetic-direct-key',content_attributes:JSON.stringify(t.message.content_attributes),additional_attributes:'{}'});
    await t.ingest(t.message);await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query("SELECT last_error FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows[0].last_error).toBe('CHATWOOT_DIRECT_SOURCE_REVIEW');
  });
  it.each([['WAID:synthetic-direct','CHATWOOT_DIRECT_SOURCE_REVIEW'],[undefined,'CHATWOOT_DIRECT_SOURCE_UNAVAILABLE']] as const)
    ('checks the persisted source for a legacy job on a guarded integration (%s)',async(source,expected)=>{
      const t=await fixture();
      await t.ingest(t.message);
      await db.database.pool.query("UPDATE integration_jobs SET status='SUCCEEDED' WHERE id=$1",[t.unknown]);
      await db.database.pool.query("UPDATE integration_jobs SET payload=payload-'outboundIntentId' WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org]);
      t.setCanonical({source_id:source});
      await createChatwootWorker({...t.options,directSourceGuardIntegrations:new Set([t.integration])}).runOnce(t.org);
      expect((await db.database.pool.query("SELECT last_error FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows[0].last_error).toBe(expected);
      expect((await db.database.pool.query("SELECT message_id FROM messaging_outbox WHERE organization_id=$1",[t.org])).rows).toEqual([]);
    });
  it('rejects a legacy source read when credentials rotate during the GET',async()=>{
    const t=await fixture();
    await t.ingest(t.message);t.setCanonical({source_id:null});
    await db.database.pool.query("UPDATE integration_jobs SET status='SUCCEEDED' WHERE id=$1",[t.unknown]);
    await db.database.pool.query("UPDATE integration_jobs SET payload=payload-'outboundIntentId' WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org]);
    const options={...t.options,directSourceGuardIntegrations:new Set([t.integration]),fetch:async(...args:Parameters<typeof fetch>)=>{
      const response=await t.options.fetch!(...args);
      await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1',[t.org]);
      return response;
    }};
    await createChatwootWorker(options).runOnce(t.org);
    expect((await db.database.pool.query("SELECT last_error FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows[0].last_error).toBe('CHATWOOT_DIRECT_SOURCE_CONTEXT_CHANGED');
    expect((await db.database.pool.query("SELECT message_id FROM messaging_outbox WHERE organization_id=$1",[t.org])).rows).toEqual([]);
  });
  it('preserves the native intent of a guarded serialized webhook and refuses malformed attributes',async()=>{
    const t=await fixture(false,'guard');
    await expect(t.ingest({...t.message,additional_attributes:'['})).rejects.toThrow();
    await t.ingest({...t.message,content_attributes:JSON.stringify(t.message.content_attributes),additional_attributes:'{}'});
    expect((await db.database.pool.query("SELECT payload->>'outboundIntentId' AS intent FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows).toEqual([{intent:t.intent}]);
  });
  it.each(['deleted','broken'] as const)('rejects %s serialized attributes before native egress',async mode=>{
    const t=await fixture(false,'guard');
    t.setCanonical({source_id:null,content_attributes:mode==='broken'?'bad':JSON.stringify({...t.message.content_attributes,deleted:true})});
    await t.ingest(t.message);await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
  });
  it.each(['object','string','other-tenant'] as const)('scopes media-echo exclusion while keeping its attendance observation (%s)',async mode=>{
    const t=await fixture(false,mode==='other-tenant'?'other':'guard');
    const mediaId=await db.transact(t.org,tx=>registerPendingMedia(tx,t.org,t.channel,{source:'QR',sourceKey:'synthetic-origin',kind:'image',fileName:'synthetic.png',descriptor:{messageId:'synthetic-origin'}}));
    const mirror=(await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state,upstream_message_id)
      VALUES($1,$2,$3,'OUTGOING','EXTERNAL_OBSERVED',$4::jsonb,'READ','synthetic-origin') RETURNING id`,[t.org,t.channel,t.next,JSON.stringify({type:'MEDIA',mediaId,kind:'image',fileName:'synthetic.png',caption:'synthetic caption'})])).rows[0].id;
    const prior=(await db.database.pool.query("SELECT id FROM integration_jobs WHERE organization_id=$1 AND message_id=$2 AND kind='MIRROR_MESSAGE' LIMIT 1",[t.org,mirror])).rows[0].id;
    await db.database.pool.query(`INSERT INTO chatwoot_mirror_attempts(organization_id,channel_id,integration_id,destination_revision,account_id,inbox_id,
        conversation_id,remote_conversation_id,cycle,message_id,job_id,lease_token,state)
      VALUES($1,$2,$3,1,7,9,$4,52,1,$5,$6,$7,'REJECTED')`,[t.org,t.channel,t.integration,t.next,mirror,prior,randomUUID()]);
    const attrs={jrc_broker_message_id:mirror};
    const raw={...t.message,source_id:null,content:'synthetic caption',attachments:[{id:5001,file_type:'image'}],
      content_attributes:mode==='string'?JSON.stringify(attrs):attrs};
    for(const id of [701,702]){await t.ingest({...raw,id});await t.ingest({...raw,id});}
    const observed=await db.database.pool.query("SELECT disposition,event->>'kind' kind FROM chatwoot_attendance_observations WHERE organization_id=$1 AND event_key IN('message:701','message:702')",[t.org]);
    expect(observed.rows).toEqual([{disposition:'APPLIED',kind:'HUMAN_PUBLIC'},{disposition:'APPLIED',kind:'HUMAN_PUBLIC'}]);
    expect((await db.database.pool.query("SELECT id FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rowCount).toBe(mode==='other-tenant'?2:0);
  });
  it.each(['object','string'] as const)('fences legacy egress when the exact Rails original has a mirror marker and null source (%s)',async mode=>{
    const t=await fixture(false,'guard'),attachments=[{id:5010,file_type:'image'}];
    await t.ingest({...t.message,content:'synthetic caption',attachments});
    await db.database.pool.query("UPDATE integration_jobs SET status='SUCCEEDED' WHERE id=$1",[t.unknown]);
    await db.database.pool.query("UPDATE integration_jobs SET payload=payload-'outboundIntentId'-'attendanceObservationId' WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org]);
    const attrs={jrc_broker_message_id:randomUUID()};
    t.setCanonical({source_id:null,attachments,content:'synthetic caption',content_attributes:mode==='string'?JSON.stringify(attrs):attrs});
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
  });
  it.each([false,true])('fences an already claimed legacy reply when a marked duplicate arrives during the Rails GET (prior credential %s)',async rotated=>{
    const t=await fixture(false,'guard');
    await t.ingest(t.message);t.setCanonical({source_id:null});
    await db.database.pool.query("UPDATE integration_jobs SET status='SUCCEEDED' WHERE id=$1",[t.unknown]);
    await db.database.pool.query("UPDATE integration_jobs SET payload=payload-'outboundIntentId'-'attendanceObservationId' WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org]);
    if(rotated){
      await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1',[t.org]);
      await db.database.pool.query("UPDATE integration_jobs SET dedupe_key='synthetic-older-key' WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org]);
    }
    const duplicate={...t.message,source_id:null,content_attributes:JSON.stringify({jrc_broker_message_id:randomUUID()})};
    const options={...t.options,fetch:async(...args:Parameters<typeof fetch>)=>{
      const response=await t.options.fetch!(...args);
      await t.ingest(duplicate);await t.ingest(duplicate);return response;
    }};
    await createChatwootWorker(options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
    expect((await db.database.pool.query("SELECT event->>'brokerMirrorMarkerObserved' mark, disposition FROM chatwoot_attendance_observations WHERE organization_id=$1 AND event_key='message:701'",[t.org])).rows).toEqual([{mark:'true',disposition:'APPLIED'}]);
  });
  it('keeps an unmarked human reply with a reply-to reference eligible once on a guarded integration',async()=>{
    const t=await fixture(false,'guard');
    const attrs={...t.message.content_attributes,in_reply_to:700};
    t.setCanonical({source_id:null,content_attributes:JSON.stringify(attrs)});
    await t.ingest({...t.message,content_attributes:attrs});await t.ingest({...t.message,content_attributes:attrs});
    await Promise.all([createChatwootWorker(t.options).runOnce(t.org),createChatwootWorker(t.options).runOnce(t.org)]);
    expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(1);
  });
  it('enqueues one new proven human reply without retrying or clearing an unrelated UNKNOWN',async()=>{
    const t=await fixture();
    const older=(await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
      VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"Previously reviewed"}','DELIVERED') RETURNING id`,[t.org,t.channel,t.next])).rows[0].id;
    await db.database.pool.query(`UPDATE integration_jobs SET payload='{"reviewedInboxTarget":{"inbox":"9"}}' WHERE message_id=$1`,[older]);
    await t.ingest(t.message);
    await createChatwootWorker(t.options).runOnce(t.org);
    const outbox=(await db.database.pool.query(`SELECT m.conversation_id,m.content,m.source FROM messaging_outbox o
      JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id WHERE o.organization_id=$1`,[t.org])).rows;
    expect(outbox).toEqual([{conversation_id:t.next,content:{type:'TEXT',text:t.message.content},source:'OPERATOR'}]);
    expect((await db.database.pool.query('SELECT status,attempts,last_error FROM integration_jobs WHERE id=$1',[t.unknown])).rows[0])
      .toEqual({status:'UNKNOWN',attempts:1,last_error:'CHATWOOT_OUTCOME_UNKNOWN'});
    expect(t.calls).toEqual(['GET /api/v1/accounts/7/conversations/52/messages']);
    expect((await db.database.pool.query('SELECT attempts,status FROM integration_jobs WHERE message_id=$1',[older])).rows)
      .toEqual([{attempts:0,status:'PENDING'}]);
    expect((await db.database.pool.query("SELECT status FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows)
      .toEqual([{status:'SUCCEEDED'}]);
  });

  it.each(['success','first-contact','first-outside-rollout','first-phone-overlap','first-source-overlap','first-id-overlap','same-contact','ambiguous-source','changed-message','historical-callback'] as const)
    ('checks a new intent on a second remote conversation, preserving older waiting jobs (%s)',async scenario=>{
      const t=await fixture(scenario==='same-contact');
      const phone='15550004242',remote=53;
      await db.database.pool.query('UPDATE messaging_contacts SET external_id=$2 WHERE id=(SELECT contact_id FROM messaging_conversations WHERE id=$1)',[t.next,phone]);
      if(scenario.startsWith('first-')){
        await db.database.pool.query("UPDATE chatwoot_conversations SET contact_id=43,source_id='older-source' WHERE conversation_id=$1",[t.next]);
        await db.database.pool.query("UPDATE messaging_contacts SET external_id='15550004000' WHERE id=(SELECT contact_id FROM messaging_conversations WHERE id=$1)",[t.next]);
        await db.database.pool.query('UPDATE messaging_contacts SET external_id=$2 WHERE id=(SELECT contact_id FROM messaging_conversations WHERE id=$1)',
          [t.conversation,scenario==='first-phone-overlap'?phone:'15550004001']);
        if(scenario==='first-source-overlap')await db.database.pool.query("UPDATE chatwoot_conversations SET source_id='second-source' WHERE conversation_id=$1",[t.conversation]);
        if(scenario==='first-id-overlap')await db.database.pool.query('UPDATE chatwoot_conversations SET contact_id=42 WHERE conversation_id=$1',[t.conversation]);
      }
      const event={...t.message,conversation:{id:remote,inbox_id:9}};
      const canonical={id:event.id,account_id:7,inbox_id:9,conversation_id:remote,message_type:1,private:false,
        sender:event.sender,content:scenario==='changed-message'?'Different canonical content':event.content,
        content_attributes:event.content_attributes,attachments:[],created_at:scenario==='historical-callback'?1_700_000_000:Math.floor(Date.now()/1000)};
      const originals=[event];
      if(scenario==='first-contact'){
        for(const id of [702,703,704])originals.push({...event,id,content_attributes:{
          jrc_broker_outbound:{...t.marker,intent_id:randomUUID()},
        }});
      }
      const options:ChatwootOptions={...t.options,firstContactIntegrations:new Set([scenario==='first-outside-rollout'?randomUUID():t.integration]),fetch:async(input,init)=>{
        const path=new URL(String(input)).pathname;
        expect(init?.method??'GET').toBe('GET');
        if(path.endsWith('/53/messages'))return Response.json({payload:originals.map(original=>({
          ...canonical,id:original.id,content_attributes:original.content_attributes,
        }))});
        if(path.endsWith('/conversations/53'))return Response.json({id:remote,account_id:7,inbox_id:9,status:'open',updated_at:100,
          meta:{sender:{id:42,phone_number:'+'+phone},assignee:{id:12,type:'user'},assignee_type:'User',team:null}});
        if(path.endsWith('/contacts/42'))return Response.json({payload:{id:42,phone_number:'+'+phone,contact_inboxes:[
          {inbox:{id:9},source_id:'second-source'},...(scenario==='ambiguous-source'?[{inbox:{id:9},source_id:'other-source'}]:[])]}});
        throw new Error('Unexpected local fixture request '+path);
      }};
      // Simulate a signed observation created before this protocol existed.
      const previous={...event,id:700,content_attributes:{jrc_broker_outbound:{...t.marker,intent_id:randomUUID()}}};
      await t.ingest(previous);
      await db.database.pool.query("UPDATE integration_jobs SET payload=payload-'newCycleAdmission' WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org]);
      await db.database.pool.query("UPDATE chatwoot_attendance_observations SET event=event-'newCycleAdmission' WHERE organization_id=$1 AND event_key='message:700'",[t.org]);
      for(const original of originals)await t.ingest(original);
      const worker=createChatwootWorker(options);
      await Promise.all([worker.runOnce(t.org),createChatwootWorker(options).runOnce(t.org)]);
      await t.ingest(event);await worker.runOnce(t.org);
      if(scenario==='first-contact'){
        for(const original of originals){
          await t.ingest(original);
          await Promise.all([worker.runOnce(t.org),createChatwootWorker(options).runOnce(t.org)]);
        }
      }
      const sent=(await db.database.pool.query('SELECT m.content,m.conversation_id FROM messaging_outbox b JOIN messaging_messages m ON m.organization_id=b.organization_id AND m.id=b.message_id WHERE b.organization_id=$1',[t.org])).rows;
      const admitted=scenario==='success'||scenario==='first-contact';
      expect(sent).toHaveLength(admitted?originals.length:0);
      if(scenario==='first-contact'){
        const keys=await db.database.pool.query('SELECT idempotency_key FROM messaging_messages WHERE organization_id=$1 AND source=\'OPERATOR\' ORDER BY idempotency_key',[t.org]);
        expect(keys.rows.map(row=>row.idempotency_key)).toEqual(originals.map(original=>`chatwoot:${t.integration}:1:${original.id}`));
      }
      const job=(await db.database.pool.query("SELECT status,last_error FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY' AND payload->>'messageId'='701'",[t.org])).rows[0];
      const waiting='CHATWOOT_CYCLE_WAITING_PREVIOUS_MIRROR';
      const expectedError={success:null,'first-contact':null,'first-outside-rollout':waiting,'first-phone-overlap':waiting,'first-source-overlap':waiting,'first-id-overlap':waiting,'same-contact':waiting,'ambiguous-source':'CHATWOOT_BINDING_MISMATCH',
        'changed-message':'CHATWOOT_HUMAN_INTENT_NOT_PROVEN','historical-callback':'CHATWOOT_CYCLE_HISTORICAL_INTENT_REVIEW'};
      expect(job.last_error).toBe(expectedError[scenario]);
      if(admitted){
        const next=(await db.database.pool.query('SELECT conversation_id FROM chatwoot_conversations WHERE organization_id=$1 AND remote_conversation_id=53',[t.org])).rows[0];
        expect(next.conversation_id).not.toBe(t.next);
        expect(sent[0]).toEqual({conversation_id:next.conversation_id,content:{type:'TEXT',text:event.content}});
      }
      expect((await db.database.pool.query("SELECT conversation_id FROM chatwoot_conversations WHERE organization_id=$1 AND remote_conversation_id=52",[t.org])).rows[0]?.conversation_id).toBe(t.next);
      expect((await db.database.pool.query("SELECT status,attempts FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY' AND payload->>'messageId'='700'",[t.org])).rows).toEqual([{status:'PENDING',attempts:0}]);
      expect((await db.database.pool.query("SELECT disposition,cycle FROM chatwoot_attendance_observations WHERE organization_id=$1 AND event_key='message:700'",[t.org])).rows).toEqual([{disposition:'WAITING_MAP',cycle:null}]);
      expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1',[t.unknown])).rows[0]).toEqual({status:'UNKNOWN',attempts:1});
    });

  it('keeps an old human callback without durable intent fenced',async()=>{
    const t=await fixture();await t.ingest({...t.message,content_attributes:{}});
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query("SELECT status,attempts FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows)
      .toEqual([{status:'PENDING',attempts:0}]);
    expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('dispatches one proven human reply in the same conversation without replaying its uncertain inbound mirror',async()=>{
    const t=await fixture(true);await t.ingest(t.message);await t.ingest(t.message);
    await Promise.all([createChatwootWorker(t.options).runOnce(t.org),createChatwootWorker(t.options).runOnce(t.org)]);
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0].n).toBe(1);
    expect((await db.database.pool.query("SELECT status FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows)
      .toEqual([{status:'SUCCEEDED'}]);
    expect((await db.database.pool.query('SELECT status,attempts,last_error FROM integration_jobs WHERE id=$1',[t.unknown])).rows[0])
      .toEqual({status:'UNKNOWN',attempts:1,last_error:'CHATWOOT_OUTCOME_UNKNOWN'});
    expect((await db.database.pool.query('SELECT state,remote_message_id FROM chatwoot_mirror_attempts WHERE job_id=$1',[t.unknown])).rows)
      .toEqual([{state:'UNKNOWN',remote_message_id:null}]);
    expect(t.calls).toEqual(['GET /api/v1/accounts/7/conversations/52/messages']);
  });

  it.each(['missing-attempt','outgoing-mirror','different-cycle','different-inbox','paused-control'] as const)
    ('keeps a same-conversation reply fenced for %s',async change=>{
      const t=await fixture(true);await t.ingest(t.message);
      if(change==='missing-attempt')await db.database.pool.query('DELETE FROM chatwoot_mirror_attempts WHERE job_id=$1',[t.unknown]);
      if(change==='outgoing-mirror')await db.database.pool.query("UPDATE messaging_messages SET direction='OUTGOING',source='OPERATOR' WHERE id=(SELECT message_id FROM integration_jobs WHERE id=$1)",[t.unknown]);
      if(change==='different-cycle')await db.database.pool.query('UPDATE chatwoot_mirror_attempts SET cycle=2 WHERE job_id=$1',[t.unknown]);
      if(change==='different-inbox')await db.database.pool.query('UPDATE chatwoot_mirror_attempts SET inbox_id=10 WHERE job_id=$1',[t.unknown]);
      if(change==='paused-control')await db.database.pool.query("UPDATE chatwoot_attendance_controls SET state='PAUSED' WHERE organization_id=$1 AND conversation_id=$2",[t.org,t.next]);
      await createChatwootWorker(t.options).runOnce(t.org);
      expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows).toEqual([]);
      expect(t.calls).toEqual([]);
    });

  it('returns the mapped provider delivery status without replaying the uncertain incoming mirror',async()=>{
    const t=await fixture(true);await t.ingest(t.message);await createChatwootWorker(t.options).runOnce(t.org);
    const outgoing=(await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0].message_id;
    await db.database.pool.query("UPDATE messaging_messages SET state='SENT',upstream_message_id='synthetic-provider-receipt' WHERE id=$1",[outgoing]);
    const patches:Record<string,unknown>[]=[];
    const options:ChatwootOptions={...t.options,async fetch(input,init){
      if(init?.method==='PATCH'&&new URL(String(input)).pathname==='/api/v1/accounts/7/conversations/52/messages/701'){
        patches.push(JSON.parse(String(init.body)));return Response.json({id:701});
      }
      return t.options.fetch!(input,init);
    }};
    await createChatwootWorker(options).runOnce(t.org);
    expect(patches).toEqual([{status:'sent',broker_delivery:{version:1,canonical_message_id:outgoing,
      provider_message_id:'synthetic-provider-receipt',state:'SENT'}}]);
    expect(t.calls).toEqual(['GET /api/v1/accounts/7/conversations/52/messages']);
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0].n).toBe(1);
    expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1',[t.unknown])).rows[0])
      .toEqual({status:'UNKNOWN',attempts:1});
  });

  it('returns the final sibling receipt for a human reply with multiple attachments',async()=>{
    const t=await fixture(true),raw={...t.message,content:'Synthetic multi-attachment reply',
      attachments:[{id:801,file_type:'image'},{id:802,file_type:'audio'}]};
    t.setCanonical({content:raw.content,attachments:raw.attachments});await t.ingest(raw);
    await createChatwootWorker(t.options).runOnce(t.org);
    const first=(await db.database.pool.query("SELECT message_id FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows[0].message_id;
    const second=(await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1 AND message_id<>$2',[t.org,first])).rows[0].message_id;
    const patches:Record<string,unknown>[]=[];
    const options:ChatwootOptions={...t.options,async fetch(input,init){
      if(init?.method==='PATCH'&&new URL(String(input)).pathname==='/api/v1/accounts/7/conversations/52/messages/701'){
        patches.push(JSON.parse(String(init.body)));return Response.json({id:701});
      }
      return t.options.fetch!(input,init);
    }};
    await db.database.pool.query("UPDATE messaging_messages SET state='SENT',upstream_message_id='synthetic-first-receipt' WHERE id=$1",[first]);
    for(let n=0;n<3;n++)await createChatwootWorker(options).runOnce(t.org);
    expect(patches).toEqual([]);
    await db.database.pool.query("UPDATE messaging_messages SET state='SENT',upstream_message_id='synthetic-second-receipt' WHERE id=$1",[second]);
    await createChatwootWorker(options).runOnce(t.org);
    expect(patches).toEqual([expect.objectContaining({status:'sent',broker_delivery:expect.objectContaining({state:'SENT'})})]);
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0].n).toBe(2);
    expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1',[t.unknown])).rows[0])
      .toEqual({status:'UNKNOWN',attempts:1});
    expect(t.calls).toEqual(['GET /api/v1/accounts/7/conversations/52/messages']);
  });

  it.each(['control','attempt-cycle','remote-map'] as const)('revalidates same-conversation %s after the canonical read',async drift=>{
    const t=await fixture(true);await t.ingest(t.message);
    const options:ChatwootOptions={...t.options,async fetch(input,init){
      const result=await t.options.fetch!(input,init);
      if(drift==='control')await db.database.pool.query("UPDATE chatwoot_attendance_controls SET state='PAUSED' WHERE organization_id=$1 AND conversation_id=$2",[t.org,t.next]);
      if(drift==='attempt-cycle')await db.database.pool.query('UPDATE chatwoot_mirror_attempts SET cycle=2 WHERE job_id=$1',[t.unknown]);
      if(drift==='remote-map')await db.database.pool.query('UPDATE chatwoot_conversations SET remote_conversation_id=53 WHERE organization_id=$1 AND conversation_id=$2',[t.org,t.next]);
      return result;
    }};
    await createChatwootWorker(options).runOnce(t.org);
    expect(t.calls).toEqual(['GET /api/v1/accounts/7/conversations/52/messages']);
    expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows).toEqual([]);
    expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1',[t.unknown])).rows[0])
      .toEqual({status:'UNKNOWN',attempts:1});
  });

  it('does not isolate a second uncertain physical conversation for the same contact',async()=>{
    const t=await fixture(true),other=randomUUID();
    await db.database.pool.query(`INSERT INTO messaging_conversations(id,organization_id,channel_id,contact_id,remote_conversation_key)
      SELECT $1,organization_id,channel_id,contact_id,$2 FROM messaging_conversations WHERE organization_id=$3 AND id=$4`,
      [other,`chatwoot-cycle:${t.integration}:54`,t.org,t.next]);
    await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
      VALUES($1,$2,$3,44,'third-source',54)`,[t.org,t.integration,other]);
    const incoming=(await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
      VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"Another physical cycle"}','DELIVERED') RETURNING id`,[t.org,t.channel,other])).rows[0].id;
    const blocked=(await db.database.pool.query(`UPDATE integration_jobs SET status='UNKNOWN',attempts=1,
      payload='{"operation":"SEND_MESSAGE","conversationId":54}' WHERE organization_id=$1 AND message_id=$2 RETURNING id`,[t.org,incoming])).rows[0].id;
    await db.database.pool.query(`INSERT INTO chatwoot_mirror_attempts(organization_id,channel_id,integration_id,destination_revision,
      account_id,inbox_id,conversation_id,remote_conversation_id,cycle,message_id,job_id,lease_token,state)
      VALUES($1,$2,$3,1,7,9,$4,54,1,$5,$6,$7,'UNKNOWN')`,[t.org,t.channel,t.integration,other,incoming,blocked,randomUUID()]);
    await t.ingest(t.message);await createChatwootWorker(t.options).runOnce(t.org);
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
