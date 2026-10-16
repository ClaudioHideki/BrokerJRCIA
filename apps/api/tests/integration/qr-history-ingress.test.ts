import {createHmac,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createQrMessagingService,ensureQrChannel} from '../../src/modules/messaging/qr-service.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
const signingKey='synthetic-history-signing-key-'.repeat(2);
beforeAll(async()=>{db=await attendanceDatabase();});afterAll(async()=>{await db?.dispose();});
async function fixture(){
  const tenant=await seedAttendanceTenant(db.database,false),engine='history-'+randomUUID();
  const {instance,channel}=await db.transact(tenant.org,async tx=>{
    const provider=(await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','History QR') RETURNING id",[tenant.org])).rows[0].id;
    const instance=(await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'History',$3,'CONNECTED') RETURNING id",[tenant.org,provider,engine])).rows[0].id;
    const channel=(await ensureQrChannel(tx,tenant.org,instance)).id;
    await tx.query("UPDATE messaging_channels SET bot_public_id='synthetic',bot_origin_reference='synthetic' WHERE organization_id=$1 AND id=$2",[tenant.org,channel]);
    return{instance,channel};
  });
  const service=(transact=db.transact)=>createQrMessagingService({baseUrl:'https://engine.test',apiKey:'synthetic',signingKey,webhookOrigin:'https://broker.test',transact,
    resolveChannel:async(id:string)=>id===channel?{organizationId:tenant.org,instanceId:instance}:undefined});
  const auth='Bearer '+createHmac('sha256',signingKey).update(`qr-webhook\0${tenant.org}\0${channel}`).digest('base64url');
  const item=(id:string,fromMe=false)=>({key:{id,remoteJid:'15550000001@s.whatsapp.net',fromMe},pushName:'Historical name',
    messageTimestamp:Math.floor(Date.now()/1000)-86400,message:{conversation:'Synthetic history '+id}});
  const envelope=(data:unknown,event='messages.set')=>({event,instance:engine,sender:'15555550100@s.whatsapp.net',data:event==='messages.set'&&!Array.isArray(data)?[data]:data});
  const read=()=>db.transact(tenant.org,async tx=>({messages:(await tx.query('SELECT * FROM messaging_messages WHERE channel_id=$1 ORDER BY created_at,upstream_message_id',[channel])).rows,
    jobs:(await tx.query('SELECT j.* FROM messaging_bot_jobs j JOIN messaging_conversations c ON c.id=j.conversation_id AND c.organization_id=j.organization_id WHERE c.channel_id=$1',[channel])).rows,
    conversations:(await tx.query('SELECT * FROM messaging_conversations WHERE channel_id=$1',[channel])).rows,
    outbox:(await tx.query('SELECT o.* FROM messaging_outbox o JOIN messaging_messages m ON m.id=o.message_id AND m.organization_id=o.organization_id WHERE m.channel_id=$1',[channel])).rows}));
  return{...tenant,channel,service,auth,item,envelope,read};
}
describe('historical QR text ingress',()=>{
  it('applies an already persisted READ receipt when the historical outgoing message arrives later',async()=>{
    const t=await fixture();
    await t.service().ingest(t.channel,t.auth,t.envelope({keyId:'read-before-history',status:'READ'},'messages.update'));
    await t.service().ingest(t.channel,t.auth,t.envelope(t.item('read-before-history',true)));
    expect((await t.read()).messages[0]).toMatchObject({state:'READ'});
  });
  it('persists both directions once across replacement and later live echoes without scheduling or pausing the bot',async()=>{
    const t=await fixture(),incoming=t.item('incoming'),outgoing=t.item('outgoing',true);
    await t.service().ingest(t.channel,t.auth,t.envelope([outgoing,incoming]));
    await t.service().ingest(t.channel,t.auth,t.envelope([incoming,outgoing]));
    await t.service().ingest(t.channel,t.auth,t.envelope(incoming,'messages.upsert'));
    await t.service().ingest(t.channel,t.auth,t.envelope(outgoing,'messages.upsert'));
    const data=await t.read();expect(data.messages).toHaveLength(2);expect(data.jobs).toEqual([]);expect(data.outbox).toEqual([]);
    expect(data.conversations).toHaveLength(1);expect(data.conversations[0].mode).toBe('BOT');
    expect(data.messages[0]).toMatchObject({direction:'INCOMING',state:'DELIVERED',created_at:new Date(incoming.messageTimestamp*1000)});
    expect(data.messages[1]).toMatchObject({direction:'OUTGOING',source:'EXTERNAL_OBSERVED',state:'SENT'});
  });
  it('does not overwrite a current contact name with a historical pushName',async()=>{
    const t=await fixture();const live=t.item('live');live.pushName='Current name';
    await t.service().ingest(t.channel,t.auth,t.envelope(live,'messages.upsert'));
    await t.service().ingest(t.channel,t.auth,t.envelope(t.item('old')));
    const rows=await db.transact(t.org,tx=>tx.query("SELECT display_name FROM messaging_contacts WHERE external_id='15550000001'"));
    expect(rows.rows[0].display_name).toBe('Current name');
  });
  it('preserves a contact created between the historical lookup and its insert',async()=>{
    const t=await fixture();let inserted=false;
    const concurrent:typeof db.transact=(org,work)=>db.transact(org,async tx=>work(new Proxy(tx,{
      get(target,key){
        if(key!=='query')return Reflect.get(target,key);
        return async(sql:string,params:unknown[])=>{
          if(!inserted&&sql.trimStart().startsWith('INSERT INTO messaging_contacts')){
            inserted=true;
            await target.query("INSERT INTO messaging_contacts(organization_id,external_id,display_name) VALUES($1,'15550000001','Current concurrent name')",[org]);
          }
          return target.query(sql,params);
        };
      }
    })));
    await t.service(concurrent).ingest(t.channel,t.auth,t.envelope(t.item('race')));
    const rows=await db.transact(t.org,tx=>tx.query("SELECT display_name FROM messaging_contacts WHERE external_id='15550000001'"));
    expect(rows.rows[0].display_name).toBe('Current concurrent name');
  });
  it('does not acknowledge unsupported history or oversized batches and rolls back the entire batch',async()=>{
    const t=await fixture();
    await expect(t.service().ingest(t.channel,t.auth,t.envelope(Array(101).fill(t.item('large'))))).rejects.toThrow('QR_HISTORY_BATCH_LIMIT');
    const media={...t.item('media'),message:{imageMessage:{caption:'Synthetic'}}};
    await expect(t.service().ingest(t.channel,t.auth,t.envelope([t.item('valid'),media]))).rejects.toThrow('QR_HISTORY_CONTENT_UNSUPPORTED');
    expect((await t.read()).messages).toEqual([]);
  });
  it('rejects wrong authorization and keeps identical provider IDs isolated between companies',async()=>{
    const a=await fixture(),b=await fixture();
    await expect(b.service().ingest(b.channel,a.auth,b.envelope(b.item('same')))).rejects.toMatchObject({code:'QR_WEBHOOK_UNAUTHORIZED'});
    await a.service().ingest(a.channel,a.auth,a.envelope(a.item('same')));
    await b.service().ingest(b.channel,b.auth,b.envelope(b.item('same')));
    expect((await a.read()).messages).toHaveLength(1);expect((await b.read()).messages).toHaveLength(1);
  });
  it('does not learn an old LID mapping and preserves historical provenance through later identity resolution',async()=>{
    const t=await fixture();const old={...t.item('old-pair'),key:{...t.item('old-pair').key,remoteJid:'123@lid',remoteJidAlt:'15550000001@s.whatsapp.net'}};
    await t.service().ingest(t.channel,t.auth,t.envelope(old));
    expect((await db.transact(t.org,tx=>tx.query('SELECT * FROM qr_contact_aliases'))).rows).toEqual([]);
    const unresolved={...t.item('pending'),key:{...t.item('pending').key,remoteJid:'123@lid',fromMe:true}};
    await t.service().ingest(t.channel,t.auth,t.envelope(unresolved));
    const fresh={...old,key:{...old.key,id:'fresh'}};
    await t.service().ingest(t.channel,t.auth,t.envelope(fresh,'messages.upsert'));
    const data=await t.read();expect(data.messages).toHaveLength(3);expect(data.conversations[0].mode).toBe('BOT');
    expect(data.jobs).toHaveLength(1); // Only the new live fact may start a bot turn.
    expect(data.messages.find(row=>row.upstream_message_id==='pending')).toMatchObject({direction:'OUTGOING'});
  });
  it('rejects a direction conflict without importing earlier items from the same batch',async()=>{
    const t=await fixture();await t.service().ingest(t.channel,t.auth,t.envelope(t.item('collision'),'messages.upsert'));
    await expect(t.service().ingest(t.channel,t.auth,t.envelope([t.item('rollback'),t.item('collision',true)]))).rejects.toThrow('QR_HISTORY_ID_CONFLICT');
    expect((await t.read()).messages.map(row=>row.upstream_message_id)).toEqual(['collision']);
  });
  it('preserves unknown dispatch attempts and refuses to classify old outgoing text while their outcome is uncertain',async()=>{
    const t=await fixture();await t.service().ingest(t.channel,t.auth,t.envelope(t.item('in')));
    const conversation=(await t.read()).conversations[0];
    await db.transact(t.org,async tx=>{
      const message=randomUUID();
      await tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state)
        VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR','{"type":"TEXT","text":"Synthetic uncertain"}','UNKNOWN')`,[message,t.org,t.channel,conversation.id]);
      await tx.query(`INSERT INTO qr_dispatch_attempts(organization_id,channel_id,conversation_id,message_id,lease_token,lease_expires_at,state)
        VALUES($1,$2,$3,$4,$5,now(),'UNKNOWN')`,[t.org,t.channel,conversation.id,message,randomUUID()]);
    });
    await expect(t.service().ingest(t.channel,t.auth,t.envelope(t.item('old-out',true)))).rejects.toMatchObject({code:'QR_HISTORY_ACK_PENDING'});
    const data=await t.read();expect(data.messages).toHaveLength(2);expect(data.conversations[0].mode).toBe('BOT');expect(data.outbox).toEqual([]);
  });
});
