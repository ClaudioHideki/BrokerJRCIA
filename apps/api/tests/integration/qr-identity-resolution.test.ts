import {createHmac,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createQrMessagingService,ensureQrChannel} from '../../src/modules/messaging/qr-service.js';
import {createPostgresObservabilityRepository} from '../../src/modules/observability/service.js';
import {Pool} from 'pg';
import {connectionStringForRole} from './helpers/task7.js';
import type {EvolutionFleetRuntime} from '../../src/modules/evolution-fleet/runtime.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
const signingKey='synthetic-identity-signing-key-'.repeat(2),owner='15555550100@s.whatsapp.net';
beforeAll(async()=>{db=await attendanceDatabase();});afterAll(async()=>{await db?.dispose();});
async function fixture(){
  const t=await seedAttendanceTenant(db.database,false);
  const engine='synthetic-identity-'+t.org;
  const {instance,channel}=await db.transact(t.org,async tx=>{
    const provider=(await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic QR') RETURNING id",[t.org])).rows[0].id;
    const instance=(await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Synthetic',$3,'CONNECTED') RETURNING id",[t.org,provider,engine])).rows[0].id as string;
    return{instance,channel:(await ensureQrChannel(tx,t.org,instance)).id};
  });
  const options={baseUrl:'https://engine.test',apiKey:'synthetic',signingKey,webhookOrigin:'https://broker.test',transact:db.transact,
    resolveChannel:async(id:string)=>id===channel?{organizationId:t.org,instanceId:instance}:undefined};
  const service=()=>createQrMessagingService(options);
  const auth='Bearer '+createHmac('sha256',signingKey).update(`qr-webhook\0${t.org}\0${channel}`).digest('base64url');
  const envelope=(id:string,alt?:string,sender:string|undefined=owner)=>({instance:engine,event:'messages.upsert',sender,
    data:{key:{id,remoteJid:'123@lid',fromMe:false,...(alt?{remoteJidAlt:alt}: {})},messageTimestamp:Math.floor(Date.now()/1000)-30,
      pushName:'Synthetic contact',message:{conversation:'Synthetic message '+id}}});
  const read=()=>db.transact(t.org,async tx=>({messages:(await tx.query('SELECT * FROM messaging_messages WHERE organization_id=$1 AND channel_id=$2 ORDER BY created_at,id',[t.org,channel])).rows,
    pending:(await tx.query('SELECT * FROM qr_identity_pending_events WHERE organization_id=$1 AND channel_id=$2 ORDER BY provider_message_id',[t.org,channel])).rows,
    contacts:(await tx.query('SELECT * FROM messaging_contacts WHERE organization_id=$1 AND external_id<>$2',[t.org,'synthetic'])).rows}));
  return{...t,instance,channel,engine,options,service,auth,envelope,read};
}
describe('durable QR LID resolution',()=>{
  it('persists before ACK, survives replacement, resolves once from an authenticated pair and does not schedule a late bot response',async()=>{
    const t=await fixture(),original=t.envelope('pending');await t.service().ingest(t.channel,t.auth,original);
    expect(await t.read()).toMatchObject({messages:[],contacts:[],pending:[{status:'WAITING'}]});
    await db.transact(t.org,tx=>tx.query("UPDATE messaging_channels SET bot_public_id='synthetic-bot',bot_origin_reference='synthetic-origin' WHERE organization_id=$1 AND id=$2",[t.org,t.channel]));
    await t.service().ingest(t.channel,t.auth,t.envelope('paired','15550000001@s.whatsapp.net'));
    await t.service().ingest(t.channel,t.auth,original);
    const result=await t.read();expect(result.messages).toHaveLength(2);expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0].external_id).toBe('15550000001');expect(result.pending[0]).toMatchObject({status:'RESOLVED',event:null});
    const jobs=await db.transact(t.org,tx=>tx.query('SELECT m.upstream_message_id FROM messaging_bot_jobs j JOIN messaging_messages m ON m.organization_id=j.organization_id AND m.id=j.message_id WHERE j.organization_id=$1',[t.org]));
    expect(jobs.rows.map(row=>row.upstream_message_id)).not.toContain('pending');
  });
  it('never uses another company mapping or acknowledges an unauthenticated event',async()=>{
    const a=await fixture(),b=await fixture();
    await a.service().ingest(a.channel,a.auth,a.envelope('known','15550000001@s.whatsapp.net'));
    await expect(b.service().ingest(b.channel,a.auth,b.envelope('forged'))).rejects.toMatchObject({code:'QR_WEBHOOK_UNAUTHORIZED'});
    await b.service().ingest(b.channel,b.auth,b.envelope('unknown'));
    expect(await b.read()).toMatchObject({messages:[],contacts:[],pending:[{status:'WAITING'}]});
    expect((await db.transact(b.org,tx=>tx.query('SELECT * FROM qr_contact_aliases'))).rows).toEqual([]);
  });
  it('quarantines conflicting LID/PN evidence instead of merging or changing a contact',async()=>{
    const t=await fixture();await t.service().ingest(t.channel,t.auth,t.envelope('first','15550000001@s.whatsapp.net'));
    await t.service().ingest(t.channel,t.auth,t.envelope('conflict','15550000002@s.whatsapp.net'));
    await t.service().ingest(t.channel,t.auth,t.envelope('later'));
    const result=await t.read();expect(result.messages).toHaveLength(1);expect(result.contacts).toHaveLength(1);
    expect(result.pending).toEqual(expect.arrayContaining([expect.objectContaining({status:'CONFLICT'})]));
  });
  it('does not reuse a mapping after an observed account change',async()=>{
    const t=await fixture();await t.service().ingest(t.channel,t.auth,t.envelope('old','15550000001@s.whatsapp.net'));
    await t.service().ingest(t.channel,t.auth,{event:'connection.update',instance:t.engine,data:{state:'open',wuid:'15555550199@s.whatsapp.net'}});
    await t.service().ingest(t.channel,t.auth,t.envelope('new',undefined,'15555550199@s.whatsapp.net'));
    expect(await t.read()).toMatchObject({messages:[{upstream_message_id:'old'}],pending:[{status:'WAITING'}]});
  });
  it('preserves unknown owner evidence without inventing its scope',async()=>{
    const t=await fixture();const payload=t.envelope('owner-unknown');delete payload.sender;
    await t.service().ingest(t.channel,t.auth,payload);
    await t.service().ingest(t.channel,t.auth,t.envelope('known','15550000001@s.whatsapp.net'));
    const result=await t.read();expect(result.messages).toHaveLength(1);
    expect(result.pending[0]).toMatchObject({status:'WAITING',scope_id:null});
  });
  it('recovers a bounded backlog in later worker turns without requiring another customer message',async()=>{
    const t=await fixture();
    for(let batch=0;batch<2;batch++){
      const base=t.envelope('unused');
      await t.service().ingest(t.channel,t.auth,{...base,data:Array.from({length:60},(_,index)=>t.envelope(`backlog-${batch}-${index}`).data)});
    }
    await t.service().ingest(t.channel,t.auth,t.envelope('mapping','15550000001@s.whatsapp.net'));
    expect((await t.read()).messages).toHaveLength(101);
    expect(await t.service().runIdentityOnce(t.org)).toEqual({processed:20});
    expect(await t.service().runIdentityOnce(t.org)).toEqual({processed:0});
    const result=await t.read();expect(result.messages).toHaveLength(121);
    expect(result.pending.every(row=>row.status==='RESOLVED'&&row.event===null)).toBe(true);
  });
  it('invalidates old aliases when a different owner is observed before the connection callback',async()=>{
    const t=await fixture();await t.service().ingest(t.channel,t.auth,t.envelope('old','15550000001@s.whatsapp.net'));
    await t.service().ingest(t.channel,t.auth,t.envelope('new',undefined,'15555550199@s.whatsapp.net'));
    expect(await t.service().runIdentityOnce(t.org)).toEqual({processed:0});
    expect((await t.read()).messages).toHaveLength(1);
  });
  it('preserves unresolved outgoing media and never turns it into incoming text or a bot turn',async()=>{
    const t=await fixture(),out=t.envelope('device-media');
    out.data.key.fromMe=true;
    const payload={...out,data:{...out.data,message:{imageMessage:{caption:'Synthetic image'}}}};
    await t.service().ingest(t.channel,t.auth,payload);
    await t.service().ingest(t.channel,t.auth,t.envelope('paired','15550000001@s.whatsapp.net'));
    const observations=await db.transact(t.org,tx=>tx.query('SELECT content FROM qr_outbound_observations WHERE organization_id=$1 AND provider_message_id=$2',[t.org,'device-media']));
    expect(observations.rows[0].content).toMatchObject({type:'MEDIA',kind:'image',caption:'Synthetic image'});
    expect((await t.read()).messages.filter(row=>row.upstream_message_id==='device-media'&&row.direction==='INCOMING')).toEqual([]);
  });
  it('routes a fresh LID-only message to the bot when its alias was already confirmed',async()=>{
    const t=await fixture();await db.transact(t.org,tx=>tx.query("UPDATE messaging_channels SET bot_public_id='synthetic-bot',bot_origin_reference='synthetic-origin' WHERE organization_id=$1 AND id=$2",[t.org,t.channel]));
    await t.service().ingest(t.channel,t.auth,t.envelope('mapping','15550000001@s.whatsapp.net'));
    await t.service().ingest(t.channel,t.auth,t.envelope('live'));
    const jobs=await db.transact(t.org,tx=>tx.query('SELECT m.upstream_message_id FROM messaging_bot_jobs j JOIN messaging_messages m ON m.organization_id=j.organization_id AND m.id=j.message_id WHERE j.organization_id=$1',[t.org]));
    expect(jobs.rows.map(row=>row.upstream_message_id)).toContain('live');
  });
  it('does not accept either contradictory pair in the same authenticated batch',async()=>{
    const t=await fixture();await t.service().ingest(t.channel,t.auth,{...t.envelope('base'),data:[t.envelope('one','15550000001@s.whatsapp.net').data,t.envelope('two','15550000002@s.whatsapp.net').data]});
    expect(await t.read()).toMatchObject({messages:[],contacts:[]});
    expect((await t.read()).pending.every(row=>row.status==='CONFLICT')).toBe(true);
  });
  it('invalidates old aliases when a new owner first emits an ordinary phone-addressed message',async()=>{
    const t=await fixture();await t.service().ingest(t.channel,t.auth,t.envelope('old','15550000001@s.whatsapp.net'));
    const payload=t.envelope('new-pn',undefined,'15555550199@s.whatsapp.net');payload.data.key.remoteJid='15550000002@s.whatsapp.net';
    await t.service().ingest(t.channel,t.auth,payload);
    expect((await db.transact(t.org,tx=>tx.query('SELECT owner_fingerprint FROM qr_identity_scopes WHERE organization_id=$1',[t.org]))).rows[0].owner_fingerprint).toBe(null);
  });
  it('rolls back alias, pending settlement and message together if persistence fails before ACK',async()=>{
    const t=await fixture();await t.service().ingest(t.channel,t.auth,t.envelope('pending'));
    const failed=createQrMessagingService({...t.options,transact:(org,work)=>db.transact(org,async tx=>{await work(tx);throw new Error('SYNTHETIC_PERSISTENCE_FAILURE');})});
    const pair=t.envelope('pair','15550000001@s.whatsapp.net');
    await expect(failed.ingest(t.channel,t.auth,pair)).rejects.toThrow('SYNTHETIC_PERSISTENCE_FAILURE');
    expect(await t.read()).toMatchObject({messages:[],pending:[{status:'WAITING'}]});
    await t.service().ingest(t.channel,t.auth,pair);expect((await t.read()).messages).toHaveLength(2);
  });
  it('reports pending facts and purges them only in the authorized channel without touching another company',async()=>{
    const a=await fixture(),b=await fixture();
    await a.service().ingest(a.channel,a.auth,a.envelope('pending'));
    await b.service().ingest(b.channel,b.auth,b.envelope('other'));
    expect(await db.transact(a.org,tx=>createPostgresObservabilityRepository().snapshot(tx,a.org))).toMatchObject({identityPending:1});
    const actor=(await db.database.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'",[a.org])).rows[0].user_id;
    const deletion=randomUUID(),lease=randomUUID();
    await db.database.pool.query(`INSERT INTO lifecycle_deletions(id,organization_id,kind,resource_id,messaging_channel_id,provider,actor_kind,actor_id,status,lease_token,lease_expires_at)
      VALUES($1,$2,'CHANNEL',$3,$4,'QR','TENANT',$5,'REMOVING_DATA',$6,now()+interval '1 minute')`,[deletion,a.org,a.instance,a.channel,actor,lease]);
    const lifecycle=new Pool({connectionString:connectionStringForRole(db.database.connectionString,'jrc_lifecycle'),max:1});try{
      await lifecycle.query('SELECT lifecycle_purge_channel($1,$2)',[deletion,lease]);
    }finally{await lifecycle.end();}
    for(const table of ['qr_identity_scopes','qr_contact_aliases','qr_identity_pending_events'])
      expect((await db.database.pool.query(`SELECT 1 FROM ${table} WHERE organization_id=$1 AND channel_id=$2`,[a.org,a.channel])).rows).toEqual([]);
    expect((await b.read()).pending).toHaveLength(1);
  });
  it('invalidates old pending facts when the same instance is rebound before any webhook from the new engine',async()=>{
    const t=await fixture();let generation=1;
    const fleet={capture:async()=>({organizationId:t.org,instanceId:t.instance,upstreamKey:t.engine,engineId:'synthetic-engine',generation,destinationFingerprint:'synthetic-destination',state:'ACTIVE',traditional:false}),
      assert:async()=>{},webhook:async()=>({token:t.auth.slice(7),assert:async()=>{},reconciliationOnly:false})} as unknown as EvolutionFleetRuntime;
    const service=createQrMessagingService({...t.options,fleet});
    for(let batch=0;batch<2;batch++)await service.ingest(t.channel,t.auth,{...t.envelope('unused'),data:Array.from({length:51},(_,index)=>t.envelope(`rebound-${batch}-${index}`).data)});
    await service.ingest(t.channel,t.auth,t.envelope('mapping','15550000001@s.whatsapp.net'));
    expect((await t.read()).messages).toHaveLength(101);
    generation=2;
    expect(await service.runIdentityOnce(t.org)).toEqual({processed:0});
    const result=await t.read();expect(result.messages).toHaveLength(101);
    expect(result.pending.filter(row=>row.status==='STALE')).toHaveLength(2);
  });
});
